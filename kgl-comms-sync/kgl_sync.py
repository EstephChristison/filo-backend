#!/usr/bin/env python3
# ═══════════════════════════════════════════════════════════════════
# KGL Comms Sync — iMessage/SMS, email, and voice-memo ingestion
# Runs on Esteph's Mac (launchd: daily 3:07 AM, or on power-on if the
# scheduled run was missed). Pushes customer communication into each
# customer's Jobber notes via the jobber-api middleware, so the
# estimating GPT / field assistant can read full customer history.
#
# Channels:
#   1. iMessage + SMS  — read from ~/Library/Messages/chat.db
#   2. Email (optional)— IMAP (Gmail/Outlook) if configured in config.json
#   3. Voice memos     — files named after a customer, noted/uploaded
#
# Matching: sender phone/email → Jobber client phones/emails.
# Writing:  one note per client per day, e.g. "📱 Text thread — Jul 12"
#           using the clientCreateNote mutation proven in jobber-mcp.
# Unmatched senders are listed in ~/.kgl-sync/unmatched.log — they are
# NEVER auto-created as clients (KGL policy: client creation needs
# Esteph's approval).
#
# Stdlib only. State in ~/.kgl-sync/. Run `--dry-run` to preview.
# ═══════════════════════════════════════════════════════════════════
import argparse
import base64
import datetime as dt
import json
import os
import re
import shutil
import sqlite3
import sys
import tempfile
import urllib.request

JOBBER_GQL = "https://jobber.kingsgardenlandscaping.com/api/graphql"
MCP_UPLOAD = "https://jobber-mcp.estephchristison.workers.dev/upload"

HOME = os.path.expanduser("~")
BASE = os.path.join(HOME, ".kgl-sync")
STATE_PATH = os.path.join(BASE, "state.json")
CONFIG_PATH = os.path.join(BASE, "config.json")
LOG_PATH = os.path.join(BASE, "sync.log")
UNMATCHED_PATH = os.path.join(BASE, "unmatched.log")
CHAT_DB = os.path.join(HOME, "Library", "Messages", "chat.db")
VOICE_DIRS = [
    os.path.join(HOME, "Library", "Group Containers",
                 "group.com.apple.VoiceMemos.shared", "Recordings"),
    os.path.join(HOME, "Library", "Application Support",
                 "com.apple.voicememos", "Recordings"),
]
APPLE_EPOCH = dt.datetime(2001, 1, 1, tzinfo=dt.timezone.utc)
SCHEDULED_HOUR, SCHEDULED_MIN = 3, 7  # matches the launchd plist


def log(msg):
    line = f"[{dt.datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {msg}"
    print(line)
    with open(LOG_PATH, "a") as f:
        f.write(line + "\n")


def load_json(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return default


def save_state(state):
    with open(STATE_PATH, "w") as f:
        json.dump(state, f, indent=2)


# ── Jobber (via jobber-api middleware; auth handled server-side) ────
def gql(query, variables=None):
    body = json.dumps({"query": query, "variables": variables or {}}).encode()
    req = urllib.request.Request(
        JOBBER_GQL, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        data = json.loads(r.read())
    if data.get("errors"):
        raise RuntimeError(f"Jobber GraphQL: {data['errors']}")
    return data["data"]


def fetch_all_clients():
    """Full client roster with phones/emails, for handle matching."""
    clients, cursor = [], None
    while True:
        d = gql(
            """query($after:String){ clients(first:200, after:$after){
                 nodes{ id name phones{ number } emails{ address } }
                 pageInfo{ hasNextPage endCursor } } }""",
            {"after": cursor})
        page = d["clients"]
        clients += page["nodes"]
        if not page["pageInfo"]["hasNextPage"]:
            return clients
        cursor = page["pageInfo"]["endCursor"]


def create_note(client_id, message, dry):
    if dry:
        log(f"  DRY-RUN note for {client_id}: {message.splitlines()[0]} "
            f"({len(message)} chars)")
        return
    d = gql(
        """mutation($cid:EncodedId!, $input:ClientCreateNoteInput!){
             clientCreateNote(clientId:$cid, input:$input){
               userErrors{ message } } }""",
        {"cid": client_id, "input": {"message": message, "pinned": False}})
    errs = d["clientCreateNote"].get("userErrors") or []
    if errs:
        raise RuntimeError("clientCreateNote rejected: " + str(errs))


# ── Handle → client matching ─────────────────────────────────────────
def digits(s):
    return re.sub(r"\D", "", s or "")


def build_lookup(clients):
    by_phone, by_email = {}, {}
    for c in clients:
        for p in c.get("phones") or []:
            d10 = digits(p.get("number"))[-10:]
            if len(d10) == 10:
                by_phone[d10] = c
        for e in c.get("emails") or []:
            addr = (e.get("address") or "").strip().lower()
            if addr:
                by_email[addr] = c
    return by_phone, by_email


def match_handle(handle, by_phone, by_email):
    h = (handle or "").strip().lower()
    if "@" in h:
        return by_email.get(h)
    d10 = digits(h)[-10:]
    return by_phone.get(d10) if len(d10) == 10 else None


# ── iMessage / SMS ───────────────────────────────────────────────────
def decode_attributed(blob):
    """Best-effort text from a typedstream attributedBody blob."""
    if not blob:
        return None
    try:
        i = blob.find(b"NSString")
        if i < 0:
            return None
        i = blob.find(b"+", i)
        if i < 0:
            return None
        i += 1
        n = blob[i]
        if n == 0x81:  # two-byte little-endian length
            n = int.from_bytes(blob[i + 1:i + 3], "little")
            i += 3
        else:
            i += 1
        return blob[i:i + n].decode("utf-8", "ignore").strip() or None
    except Exception:
        return None


def read_messages(since_ns):
    """Copy chat.db (avoids lock) and pull messages newer than since_ns."""
    tmp = tempfile.mkdtemp(prefix="kglsync-")
    try:
        for ext in ("", "-wal", "-shm"):
            src = CHAT_DB + ext
            if os.path.exists(src):
                shutil.copy2(src, os.path.join(tmp, "chat.db" + ext))
        con = sqlite3.connect(os.path.join(tmp, "chat.db"))
        rows = con.execute(
            """SELECT m.date, m.is_from_me, m.text, m.attributedBody,
                      h.id, c.chat_identifier, c.display_name
               FROM message m
               JOIN chat_message_join j ON j.message_id = m.ROWID
               JOIN chat c ON c.ROWID = j.chat_id
               LEFT JOIN handle h ON h.ROWID = m.handle_id
               WHERE m.date > ? ORDER BY m.date""", (since_ns,)).fetchall()
        con.close()
        out, max_ns = [], since_ns
        for date_ns, from_me, text, ablob, handle, chat_id, disp in rows:
            body = (text or "").strip() or decode_attributed(ablob)
            if not body:
                continue
            when = APPLE_EPOCH + dt.timedelta(seconds=date_ns / 1e9)
            out.append({
                "when": when.astimezone(),
                "from_me": bool(from_me),
                "body": body,
                "handle": handle or chat_id,
                "group": bool(disp),
            })
            max_ns = max(max_ns, date_ns)
        return out, max_ns
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def sync_messages(state, by_phone, by_email, dry):
    if not os.path.exists(CHAT_DB):
        log("iMessage: chat.db not found — is this the right Mac?")
        return
    try:
        msgs, max_ns = read_messages(int(state.get("imessage_ns", 0)))
    except sqlite3.OperationalError as e:
        log(f"iMessage: CANNOT READ chat.db ({e}). Grant Full Disk Access "
            "to /usr/bin/python3 in System Settings → Privacy & Security.")
        return
    if not msgs:
        log("iMessage: no new messages.")
        return
    per_client, unmatched = {}, {}
    for m in msgs:
        if m["group"]:
            continue  # group chats skipped in V1
        client = match_handle(m["handle"], by_phone, by_email)
        if client:
            per_client.setdefault(client["id"], (client, []))[1].append(m)
        elif not m["from_me"]:
            unmatched.setdefault(m["handle"], 0)
            unmatched[m["handle"]] += 1
    for cid, (client, items) in per_client.items():
        lines = []
        for m in items:
            who = "Esteph" if m["from_me"] else client["name"]
            lines.append(f"[{m['when'].strftime('%b %-d %-I:%M %p')}] "
                         f"{who}: {m['body']}")
        day = items[-1]["when"].strftime("%b %-d, %Y")
        note = (f"\U0001F4F1 Text thread — {day} (auto-synced)\n"
                + "\n".join(lines))
        try:
            create_note(cid, note, dry)
            log(f"iMessage: {len(items)} message(s) → {client['name']}")
        except Exception as e:
            log(f"iMessage: FAILED writing note for {client['name']}: {e}")
            return  # don't advance watermark on write failure
    if unmatched:
        with open(UNMATCHED_PATH, "a") as f:
            for h, n in unmatched.items():
                f.write(f"{dt.date.today()} {h}: {n} message(s), "
                        "no Jobber client matched\n")
        log(f"iMessage: {len(unmatched)} sender(s) had no Jobber match "
            f"(see unmatched.log) — never auto-created.")
    if not dry:
        state["imessage_ns"] = max_ns
        save_state(state)


# ── Email (optional, via IMAP; configure in config.json) ────────────
def sync_email(state, cfg, by_phone, by_email, dry):
    imap_cfg = cfg.get("imap") or {}
    if not imap_cfg.get("host"):
        log("Email: not configured (add imap {host,user,password} to "
            "config.json — Gmail: imap.gmail.com w/ app password; "
            "Outlook: outlook.office365.com). Skipping.")
        return
    import email
    import email.utils
    import imaplib
    since_ts = state.get("email_ts", 0)
    since_date = (dt.datetime.fromtimestamp(since_ts or
                  (dt.datetime.now().timestamp() - 86400)))
    box = imaplib.IMAP4_SSL(imap_cfg["host"])
    box.login(imap_cfg["user"], imap_cfg["password"])
    newest = since_ts
    for folder in imap_cfg.get("folders", ["INBOX", '"[Gmail]/Sent Mail"']):
        try:
            if box.select(folder, readonly=True)[0] != "OK":
                continue
            typ, data = box.search(
                None, f'(SINCE "{since_date.strftime("%d-%b-%Y")}")')
            for num in (data[0].split() if typ == "OK" else []):
                typ, md = box.fetch(num, "(RFC822)")
                if typ != "OK":
                    continue
                msg = email.message_from_bytes(md[0][1])
                ts = email.utils.parsedate_to_datetime(
                    msg.get("Date")).timestamp()
                if ts <= since_ts:
                    continue
                addrs = [a for _, a in email.utils.getaddresses(
                    [msg.get("From", ""), msg.get("To", ""),
                     msg.get("Cc", "")])]
                me = imap_cfg["user"].lower()
                others = [a.lower() for a in addrs if a and a.lower() != me]
                client = next((by_email.get(a) for a in others
                               if by_email.get(a)), None)
                if not client:
                    continue
                body = ""
                part = msg.get_body(preferencelist=("plain",)) if hasattr(
                    msg, "get_body") else None
                if part:
                    body = part.get_content()
                body = re.sub(r"\n{3,}", "\n\n", (body or "").strip())[:4000]
                sender = (email.utils.parseaddr(msg.get("From"))[1]
                          or "").lower()
                who = "Esteph" if sender == me else client["name"]
                when = dt.datetime.fromtimestamp(ts).strftime(
                    "%b %-d, %Y %-I:%M %p")
                note = (f"✉️ Email — {when} (auto-synced)\n"
                        f"From: {who}\nSubject: {msg.get('Subject','')}\n\n"
                        f"{body}")
                create_note(client["id"], note, dry)
                log(f"Email: '{msg.get('Subject','')[:40]}' → "
                    f"{client['name']}")
                newest = max(newest, ts)
        except Exception as e:
            log(f"Email: error in {folder}: {e}")
    box.logout()
    if not dry and newest > since_ts:
        state["email_ts"] = newest
        save_state(state)


# ── Voice memos named after a customer ──────────────────────────────
def sync_voice_memos(state, cfg, clients, dry):
    seen = set(state.get("voice_seen", []))
    mcp_key = cfg.get("mcp_api_key")
    found = []
    for d in VOICE_DIRS:
        if os.path.isdir(d):
            for fn in os.listdir(d):
                if fn.lower().endswith((".m4a", ".mp3", ".wav")):
                    found.append(os.path.join(d, fn))
    for path in found:
        fn = os.path.basename(path)
        if fn in seen:
            continue
        stem = re.sub(r"[^A-Za-z ]+", " ", os.path.splitext(fn)[0]).lower()
        client = next(
            (c for c in clients
             if c["name"].lower() in stem
             or (len(c["name"].split()) > 1
                 and c["name"].split()[-1].lower() in stem.split()
                 and len(c["name"].split()[-1]) >= 4)), None)
        if not client:
            continue
        when = dt.datetime.fromtimestamp(
            os.path.getmtime(path)).strftime("%b %-d, %Y %-I:%M %p")
        try:
            if mcp_key:
                with open(path, "rb") as f:
                    blob = f.read()
                if len(blob) <= 20 * 1024 * 1024 and not dry:
                    req = urllib.request.Request(
                        MCP_UPLOAD + "?client_id=" +
                        urllib.parse.quote(client["id"]) +
                        "&filename=" + urllib.parse.quote(fn) +
                        "&message=" + urllib.parse.quote(
                            f"\U0001F399 Voice memo — {when} (auto-synced)"),
                        data=blob,
                        headers={"Authorization": f"Bearer {mcp_key}",
                                 "Content-Type": "audio/m4a"})
                    urllib.request.urlopen(req, timeout=300).read()
                log(f"Voice: uploaded '{fn}' → {client['name']}")
            else:
                create_note(client["id"],
                            f"\U0001F399 Voice memo recorded — {when} "
                            f"(auto-synced)\nFile: {fn}\n(Add mcp_api_key "
                            "to config.json to attach audio directly.)",
                            dry)
                log(f"Voice: noted '{fn}' → {client['name']} (no upload key)")
            seen.add(fn)
        except Exception as e:
            log(f"Voice: FAILED '{fn}': {e}")
    if not dry:
        state["voice_seen"] = sorted(seen)
        save_state(state)


# ── Main ─────────────────────────────────────────────────────────────
def already_ran_today(state):
    last = state.get("last_success", 0)
    now = dt.datetime.now()
    boundary = now.replace(hour=SCHEDULED_HOUR, minute=SCHEDULED_MIN,
                           second=0, microsecond=0)
    if boundary > now:
        boundary -= dt.timedelta(days=1)
    return last >= boundary.timestamp()


def main():
    ap = argparse.ArgumentParser(description="KGL comms → Jobber notes sync")
    ap.add_argument("--dry-run", action="store_true",
                    help="show what would sync; write nothing")
    ap.add_argument("--force", action="store_true",
                    help="run even if already ran since last 3 AM boundary")
    args = ap.parse_args()

    os.makedirs(BASE, exist_ok=True)
    state = load_json(STATE_PATH, {})
    cfg = load_json(CONFIG_PATH, {})

    if not args.force and not args.dry_run and already_ran_today(state):
        return  # power-on trigger, but the 3 AM run already happened

    log("── KGL comms sync starting "
        + ("(DRY RUN) " if args.dry_run else "") + "──")
    try:
        clients = fetch_all_clients()
    except Exception as e:
        log(f"FATAL: cannot reach Jobber middleware: {e}")
        sys.exit(1)
    log(f"Jobber roster: {len(clients)} clients loaded.")
    by_phone, by_email = build_lookup(clients)

    sync_messages(state, by_phone, by_email, args.dry_run)
    sync_email(state, cfg, by_phone, by_email, args.dry_run)
    sync_voice_memos(state, cfg, clients, args.dry_run)

    if not args.dry_run:
        state["last_success"] = dt.datetime.now().timestamp()
        save_state(state)
    log("── KGL comms sync complete ──")


if __name__ == "__main__":
    import urllib.parse  # used by voice upload
    main()
