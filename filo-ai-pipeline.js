// ═══════════════════════════════════════════════════════════════════
// FILO — AI Pipeline Module
// Real OpenAI GPT-4o + gpt-image-1 + Replicate SDXL Integration
// Drop-in replacement for callManusAI() placeholder
// ═══════════════════════════════════════════════════════════════════

import OpenAI from 'openai';
import Replicate from 'replicate';

// ─── Configuration ───────────────────────────────────────────────

const config = {
  openaiKey: process.env.OPENAI_API_KEY,
  replicateToken: process.env.REPLICATE_API_TOKEN,
  imageProvider: process.env.IMAGE_PROVIDER || 'dalle', // 'dalle' | 'replicate'
  imageQuality: process.env.IMAGE_QUALITY || 'hd',      // 'standard' | 'hd'
  imageSize: process.env.IMAGE_SIZE || '1792x1024',      // landscape format
  gptModel: process.env.GPT_MODEL || 'gpt-4o',
};

// Defer instantiation — only create if key is present, avoids crash at import time
const openai = config.openaiKey ? new OpenAI({ apiKey: config.openaiKey, timeout: 120_000 }) : null;
const replicate = config.replicateToken ? new Replicate({ auth: config.replicateToken }) : null;

// ─── System Prompts ──────────────────────────────────────────────

const PROMPTS = {
  PLANT_DETECTOR: `You are an expert horticulturist and landscape analyst. You identify plants in residential landscape photographs with high accuracy.

Given a photograph of a residential landscape:
1. Identify every visible plant, shrub, tree, and ground cover
2. For each plant, provide:
   - common_name: Common name (e.g., "Knockout Rose")
   - botanical_name: Botanical/Latin name if identifiable
   - confidence: 0.0-1.0 confidence score
   - position_x: Horizontal center position as percentage (0-100, left to right)
   - position_y: Vertical center position as percentage (0-100, top to bottom)
   - bounding_box: { x, y, width, height } as percentages
   - category: one of "tree", "shrub", "perennial", "annual", "groundcover", "ornamental_grass", "vine", "succulent"
   - health_assessment: "healthy", "stressed", "declining", or "dead"
   - approximate_size: Estimated container-equivalent size (e.g., "3-gallon", "15-gallon")

Return ONLY a valid JSON object: { "plants": [...] }
Be conservative with confidence scores. If unsure, set confidence below 0.5.
Prioritize common residential landscape plants for the geographic region mentioned.`,

  LANDSCAPE_ARCHITECT: `You are a professional landscape architect creating plant placement plans for residential properties. You have decades of experience designing landscapes in all USDA zones.

Design principles you ALWAYS follow:
1. LAYERING: Ground covers and low plants in front (viewer-side), mid-height shrubs in middle, tall specimens and trees in back
2. SPACING: Plants are placed at spacing appropriate for their MATURE size at the specified container size. A 1-gallon plant looks like a 1-gallon plant, not a mature specimen.
3. REPETITION: Use odd numbers (3, 5, 7) of the same plant for natural groupings
4. COLOR THEORY: Coordinate bloom colors and foliage colors for seasonal interest
5. ARCHITECTURE: Respect the home's architectural style. Formal homes get formal plantings. Modern homes get clean lines.
6. SIGHT LINES: Never block windows, doors, or walkways. Frame architectural features.
7. MAINTENANCE: Match water and sun needs within each bed zone

Return ONLY a valid JSON object with this structure:
{
  "design_rationale": "Brief explanation of design approach",
  "plant_placements": [
    {
      "plant_library_id": "UUID from available_plants",
      "common_name": "Plant name",
      "quantity": number,
      "container_size": "e.g., 3-gal",
      "position_x": 0-100,
      "position_y": 0-100,
      "z_index": layer depth (0=back, higher=front),
      "layer": "background" | "midground" | "foreground" | "accent",
      "grouping_notes": "e.g., cluster of 3 along south fence"
    }
  ],
  "services_recommended": {
    "soil_amendment_cy": estimated cubic yards,
    "mulch_cy": estimated cubic yards,
    "edging_lf": estimated linear feet,
    "irrigation_needed": true/false,
    "lighting_zones": number or 0
  },
  "design_summary": "2-3 sentence summary for the estimate"
}`,

  DESIGN_CHAT: `You are a landscape design assistant interpreting user modification commands for an existing landscape design. You understand natural language commands and translate them into structured design actions.

Available actions:
- swap_plant: Replace one plant species with another
- add_plant: Add a new plant to the design
- remove_plant: Remove a specific plant or all of a species
- move_plant: Reposition a plant
- resize_bed: Expand or contract the planting bed
- adjust_quantity: Change the count of a plant species

For each command, return a JSON object:
{
  "message": "Natural language response to the user explaining what you did",
  "actions": [
    {
      "type": "swap_plant|add_plant|remove_plant|move_plant|resize_bed|adjust_quantity",
      "oldPlantId": "UUID (for swap/remove)",
      "newPlantId": "UUID (for swap/add)",
      "plantId": "UUID (for add/remove/move)",
      "designPlantId": "UUID of specific design_plant record (for remove/move)",
      "quantity": number (for add/adjust),
      "x": position (for add/move),
      "y": position (for add/move),
      "reason": "Why this action was taken"
    }
  ],
  "warnings": ["Any concerns about the modification, e.g., sun compatibility issues"]
}

If the user's command is ambiguous, ask for clarification in the message and return empty actions.`,

  NARRATIVE_WRITER: `You are a professional landscape design proposal writer. You write formal, third-person scope of work narratives that help landscaping companies sell their work to residential clients.

Style guidelines:
- Formal but warm tone. Third person ("The proposed design...")
- Describe the design philosophy and approach
- Reference specific plants by common name with brief descriptive language
- Mention seasonal interest and year-round appeal
- Address the client's specific conditions (sun, style preferences)
- Keep it to 2-3 paragraphs (150-250 words)
- Do NOT mention pricing, quantities, or container sizes
- Do NOT mention FILO or any software
- Write as if the landscaping company authored this

Return a JSON object: { "narrative": "the scope text", "closing": "a brief closing statement" }`,

  NURSERY_PARSER: `You are an expert at parsing nursery availability lists. These come in many formats — wholesale price sheets, availability PDFs, inventory spreadsheets. Extract structured plant data from the provided content.

For each plant found, extract:
{
  "common_name": "name",
  "botanical_name": "if listed",
  "container_size": "e.g., 1-gal, 3-gal, 5-gal, 15-gal, 30-gal",
  "wholesale_price": number or null,
  "retail_price": number or null,
  "quantity_available": number or null,
  "category": "tree|shrub|perennial|annual|groundcover|ornamental_grass|vine|succulent",
  "notes": "any additional info"
}

Return: { "plants": [...], "parse_warnings": ["any issues encountered"], "source_format": "description of the document format" }

Be thorough. Real nursery lists often have inconsistent formatting, abbreviations (e.g., "Lor. chin." for Loropetalum chinense), and mixed units.`,
};

// ═══════════════════════════════════════════════════════════════════
// CORE AI SERVICE CLASS
// ═══════════════════════════════════════════════════════════════════

export default class AIService {
  constructor(db) {
    this.db = db;
  }

  // ─── Plant Detection (Step 4) ──────────────────────────────────

  async detectPlants(photoUrl, areaId, options = {}) {
    if (!openai) return { success: false, error: 'OpenAI not configured', plants: [] };
    const { location, usdaZone } = options;

    try {
      const locationContext = location
        ? `This property is in ${location.city}, ${location.state} (USDA Zone ${usdaZone || 'unknown'}).`
        : '';

      const response = await openai.chat.completions.create({
        model: config.gptModel,
        messages: [{
          role: 'system',
          content: PROMPTS.PLANT_DETECTOR,
        }, {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: photoUrl, detail: 'high' },
            },
            {
              type: 'text',
              text: `Identify all plants in this residential landscape photo. ${locationContext} Return the JSON analysis.`,
            },
          ],
        }],
        response_format: { type: 'json_object' },
        max_tokens: 4000,
        temperature: 0.2,
      });

      const result = JSON.parse(response.choices[0].message.content);
      const plants = result.plants || [];

      // Store detected plants in the database
      const savedPlants = [];
      for (const plant of plants) {
        const saved = await this.db.getOne(
          `INSERT INTO existing_plants (property_area_id, identified_name, confidence, mark, position_x, position_y, bounding_box, comment)
           VALUES ($1, $2, $3, 'keep', $4, $5, $6, $7) RETURNING *`,
          [
            areaId,
            `${plant.common_name}${plant.botanical_name ? ` (${plant.botanical_name})` : ''}`,
            plant.confidence,
            plant.position_x,
            plant.position_y,
            JSON.stringify(plant.bounding_box || {}),
            plant.health_assessment ? `Health: ${plant.health_assessment}. Size: ~${plant.approximate_size || 'unknown'}` : null,
          ]
        );
        savedPlants.push({ ...saved, raw: plant });
      }

      return {
        success: true,
        plantCount: savedPlants.length,
        plants: savedPlants,
        usage: {
          model: config.gptModel,
          promptTokens: response.usage?.prompt_tokens,
          completionTokens: response.usage?.completion_tokens,
        },
      };
    } catch (err) {
      console.error('[AI:detectPlants] Error:', err);
      return { success: false, error: err.message, plants: [] };
    }
  }

  // ─── Design Generation (Step 6) ────────────────────────────────

  async generateDesign(designId, options) {
    if (!openai) return { success: false, error: 'OpenAI not configured' };
    const {
      photoUrls, sunExposure, designStyle, specialRequests,
      availablePlants, existingPlants, location, lighting, hardscape,
    } = options;

    try {
      // Step 1: Generate plant placement plan via GPT-4o
      const plantPlan = await this.generatePlantPlan({
        photoUrl: photoUrls[0], // Primary photo
        sunExposure,
        designStyle,
        specialRequests,
        availablePlants: availablePlants.map(p => ({
          id: p.id,
          common_name: p.common_name,
          botanical_name: p.botanical_name,
          category: p.category,
          container_size: p.container_size,
          mature_height: p.mature_height,
          mature_width: p.mature_width,
          sun_requirement: p.sun_requirement,
          water_needs: p.water_needs,
          bloom_color: p.bloom_color,
          bloom_season: p.bloom_season,
          retail_price: p.retail_price,
        })),
        existingPlantsToKeep: existingPlants.filter(p => p.mark === 'keep'),
        existingPlantsToRemove: existingPlants.filter(p => p.mark === 'remove'),
        location,
        lighting,
        hardscape,
      });

      if (!plantPlan.success) {
        await this.updateDesignStatus(designId, 'failed', plantPlan.error);
        return plantPlan;
      }

      // Step 2: Store plant placements in the database
      const placements = plantPlan.data.plant_placements || [];
      for (const placement of placements) {
        await this.db.query(
          `INSERT INTO design_plants (design_id, plant_library_id, quantity, container_size, position_x, position_y, z_index, layer, notes)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            designId,
            placement.plant_library_id,
            placement.quantity || 1,
            placement.container_size,
            placement.position_x,
            placement.position_y,
            placement.z_index || 0,
            placement.layer || 'midground',
            placement.grouping_notes,
          ]
        );
      }

      // Step 3: Generate landscape rendering
      const rendering = await this.generateRendering({
        photoUrl: photoUrls[0],
        plantPlan: plantPlan.data,
        designStyle,
        sunExposure,
        location,
      });

      // Step 4: Update design record
      const designData = {
        plant_placements: placements,
        services_recommended: plantPlan.data.services_recommended,
        design_summary: plantPlan.data.design_summary,
        rendering_url: rendering.url || null,
      };

      await this.db.query(
        `UPDATE designs SET
          generation_status = $1, generation_completed_at = NOW(),
          plant_placements = $2, design_data = $3,
          rendering_url = $4, ai_model = $5
         WHERE id = $6`,
        [
          rendering.success ? 'completed' : 'completed_no_render',
          JSON.stringify(placements),
          JSON.stringify(designData),
          rendering.url,
          `${config.gptModel} + ${config.imageProvider}`,
          designId,
        ]
      );

      return {
        success: true,
        designId,
        plantCount: placements.length,
        renderingUrl: rendering.url,
        planData: plantPlan.data,
        renderingProvider: config.imageProvider,
      };
    } catch (err) {
      console.error('[AI:generateDesign] Error:', err);
      await this.updateDesignStatus(designId, 'failed', err.message);
      return { success: false, error: err.message };
    }
  }

  async generatePlantPlan(context) {
    if (!openai) return { success: false, error: 'OpenAI not configured' };
    try {
      const messages = [
        { role: 'system', content: PROMPTS.LANDSCAPE_ARCHITECT },
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: context.photoUrl, detail: 'high' } },
            {
              type: 'text',
              text: `Design a landscape for this property.

SITE CONDITIONS:
- Location: ${context.location?.city || 'Unknown'}, ${context.location?.state || 'Unknown'} (USDA Zone ${context.location?.zone || 'Unknown'})
- Sun exposure: ${context.sunExposure || 'full_sun'}
- Design style: ${context.designStyle || 'naturalistic'}

CLIENT REQUESTS:
${context.specialRequests || 'No special requests.'}
${context.lighting ? `- Lighting requested: ${JSON.stringify(context.lighting)}` : ''}
${context.hardscape ? `- Hardscape notes: ${context.hardscape}` : ''}

EXISTING PLANTS TO KEEP (do NOT place anything where these are):
${context.existingPlantsToKeep?.map(p => `- ${p.identified_name} at position (${p.position_x}, ${p.position_y})`).join('\n') || 'None'}

PLANTS TO REMOVE (these spots are available for new planting):
${context.existingPlantsToRemove?.map(p => `- ${p.identified_name} at position (${p.position_x}, ${p.position_y})`).join('\n') || 'None'}

AVAILABLE PLANT INVENTORY (select ONLY from these):
${JSON.stringify(context.availablePlants?.slice(0, 50), null, 0)}

Create a complete plant placement plan using ONLY plants from the available inventory. Return the JSON design.`,
            },
          ],
        },
      ];

      const response = await openai.chat.completions.create({
        model: config.gptModel,
        messages,
        response_format: { type: 'json_object' },
        max_tokens: 4000,
        temperature: 0.4,
      });

      const data = JSON.parse(response.choices[0].message.content);
      return { success: true, data };
    } catch (err) {
      console.error('[AI:generatePlantPlan] Error:', err);
      return { success: false, error: err.message };
    }
  }

  // ─── Landscape Rendering ───────────────────────────────────────

  async generateRendering(context) {
    const { photoUrl, plantPlan, designStyle, sunExposure, location } = context;

    // Build a descriptive prompt from the plant plan
    const plantList = (plantPlan.plant_placements || [])
      .map(p => `${p.quantity || 1}x ${p.common_name} (${p.container_size})`)
      .join(', ');

    const styleDescriptions = {
      formal: 'formal symmetrical garden with clean geometric lines and manicured hedges',
      naturalistic: 'naturalistic cottage garden with flowing organic borders and layered plantings',
      modern: 'modern minimalist landscape with clean architectural lines and strategic specimen plantings',
      tropical: 'lush tropical garden with bold foliage and dramatic textures',
      xeriscape: 'drought-tolerant xeriscape with native plants, decomposed granite, and boulders',
    };

    const prompt = `Ultra-photorealistic photograph of a beautifully landscaped residential front yard. ${styleDescriptions[designStyle] || styleDescriptions.naturalistic}. Features these specific plants: ${plantList}. Ground covers and low plants in the foreground, medium shrubs in the middle, taller plants and trees in the background. ${sunExposure === 'full_sun' ? 'Bright natural daylight with warm shadows' : sunExposure === 'partial_shade' ? 'Dappled sunlight filtering through trees' : 'Soft shaded lighting under tree canopy'}. Professional landscape photography, 85mm lens, golden hour lighting. The home architecture is visible in the background. Fresh mulch bed borders. ${location?.state === 'TX' ? 'South Texas residential neighborhood' : 'Suburban American neighborhood'}.`;

    try {
      if (config.imageProvider === 'replicate' && replicate) {
        return await this.generateWithReplicate(prompt, photoUrl);
      }
      return await this.generateWithDalle(prompt);
    } catch (err) {
      console.error(`[AI:generateRendering] ${config.imageProvider} failed:`, err);

      // Fallback: try the other provider
      if (config.imageProvider === 'dalle' && replicate) {
        console.log('[AI:generateRendering] Falling back to Replicate...');
        try {
          return await this.generateWithReplicate(prompt, photoUrl);
        } catch (fallbackErr) {
          console.error('[AI:generateRendering] Fallback also failed:', fallbackErr);
        }
      }

      return { success: false, url: null, error: err.message };
    }
  }

  async generateWithDalle(prompt) {
    // Uses gpt-image-1 via images.generate for text-to-image landscape rendering.
    // Note: images.edit (inpainting) is used by /removal-preview and /design-render routes
    // in filo-api-server.js for photo-based editing with masks.
    const response = await openai.images.generate({
      model: 'gpt-image-1',
      prompt,
      n: 1,
      size: '1536x1024',
      quality: 'high',
    });

    const resultData = response.data[0];
    let imageUrl;
    if (resultData.b64_json) {
      // gpt-image-1 returns b64_json by default — convert to data URL
      imageUrl = `data:image/png;base64,${resultData.b64_json}`;
    } else {
      imageUrl = resultData.url;
    }

    return {
      success: true,
      url: imageUrl,
      provider: 'gpt-image-1',
    };
  }

  async generateWithReplicate(prompt, referencePhotoUrl) {
    // Use SDXL for high-quality landscape rendering
    const output = await replicate.run(
      'stability-ai/sdxl:39ed52f2a78e934b3ba6e2a89f5b1c712de7dfea535525255b1aa35c5565e08b',
      {
        input: {
          prompt,
          negative_prompt: 'cartoon, illustration, painting, sketch, drawing, anime, 3d render, blurry, low quality, watermark, text, logo, artificial, plastic',
          width: 1344,
          height: 768,
          num_inference_steps: 50,
          guidance_scale: 7.5,
          scheduler: 'K_EULER',
          refine: 'expert_ensemble_refiner',
          high_noise_frac: 0.8,
        },
      }
    );

    // Replicate returns an array of URLs
    const imageUrl = Array.isArray(output) ? output[0] : output;

    return {
      success: true,
      url: imageUrl,
      provider: 'sdxl-replicate',
      cost: 0.003,
    };
  }

  // ─── Chat Commands (Step 7) ────────────────────────────────────

  async processDesignChat(command, designId, currentPlants, availablePlants) {
    if (!openai) return { success: false, message: 'AI service not configured', actions: [] };
    try {
      const response = await openai.chat.completions.create({
        model: config.gptModel,
        messages: [
          { role: 'system', content: PROMPTS.DESIGN_CHAT },
          {
            role: 'user',
            content: `User command: "${command}"

Current design plants:
${JSON.stringify(currentPlants.map(p => ({
  designPlantId: p.id,
  plantId: p.plant_library_id,
  name: p.common_name,
  quantity: p.quantity,
  position: { x: p.position_x, y: p.position_y },
  container: p.container_size,
})), null, 2)}

Available plants for substitution/addition:
${JSON.stringify(availablePlants.map(p => ({
  id: p.id,
  name: p.common_name,
  botanical: p.botanical_name,
  category: p.category,
  sun: p.sun_requirement,
  price: p.retail_price,
  container: p.container_size,
})), null, 2)}

Interpret the command and return the action JSON.`,
          },
        ],
        response_format: { type: 'json_object' },
        max_tokens: 2000,
        temperature: 0.3,
      });

      const result = JSON.parse(response.choices[0].message.content);
      return {
        success: true,
        message: result.message || 'Design updated.',
        actions: result.actions || [],
        warnings: result.warnings || [],
      };
    } catch (err) {
      console.error('[AI:processDesignChat] Error:', err);
      return {
        success: false,
        message: 'I had trouble processing that command. Could you rephrase it?',
        actions: [],
      };
    }
  }

  // ─── Scope Narrative Generation (Step 9) ───────────────────────

  async generateNarrative(context) {
    if (!openai) {
      // Return a basic fallback narrative when AI is not configured
      return {
        success: true,
        text: `${context.companyName || 'Our company'} is pleased to present this comprehensive landscape design proposal. The proposed design integrates carefully selected species chosen for their compatibility with the property's conditions and the local climate.`,
        closing: 'We look forward to bringing this vision to life.',
        fallback: true,
      };
    }
    const {
      companyName, clientName, address, designStyle,
      sunExposure, plants, lighting, hardscape, specialRequests,
    } = context;

    try {
      const response = await openai.chat.completions.create({
        model: config.gptModel,
        messages: [
          { role: 'system', content: PROMPTS.NARRATIVE_WRITER },
          {
            role: 'user',
            content: `Write a scope of work narrative for this landscape design proposal:

Company: ${companyName}
Client: ${clientName}
Property: ${address}
Design Style: ${designStyle || 'naturalistic'}
Sun Exposure: ${sunExposure || 'full sun'}
Plant Selections: ${plants?.join(', ') || 'various species'}
${lighting ? `Landscape Lighting: ${Array.isArray(lighting) ? lighting.join(', ') : 'Included'}` : ''}
${hardscape ? `Hardscape Notes: ${hardscape}` : ''}
${specialRequests ? `Special Requests: ${specialRequests}` : ''}

Write the narrative and closing statement as JSON.`,
          },
        ],
        response_format: { type: 'json_object' },
        max_tokens: 1500,
        temperature: 0.6,
      });

      const result = JSON.parse(response.choices[0].message.content);
      return {
        success: true,
        text: result.narrative || result.text,
        closing: result.closing || '',
      };
    } catch (err) {
      console.error('[AI:generateNarrative] Error:', err);
      // Graceful fallback — generate a basic narrative
      return {
        success: true,
        text: `${companyName} is pleased to present this comprehensive landscape design proposal for the ${clientName} residence. The proposed design embraces a ${designStyle || 'naturalistic'} aesthetic, integrating ${plants?.length || 'carefully selected'} species chosen for their compatibility with the property's ${sunExposure || 'full sun'} exposure and the local climate. Each specimen has been positioned to create a layered composition that provides year-round visual interest while requiring minimal ongoing maintenance.`,
        closing: `We look forward to bringing this vision to life. Please don't hesitate to reach out with any questions.`,
        fallback: true,
      };
    }
  }

  // ─── Nursery List Parsing ──────────────────────────────────────

  async parseNurseryList(content, fileType) {
    if (!openai) return { success: false, error: 'OpenAI not configured', plants: [] };
    try {
      const response = await openai.chat.completions.create({
        model: config.gptModel,
        messages: [
          { role: 'system', content: PROMPTS.NURSERY_PARSER },
          {
            role: 'user',
            content: `Parse this nursery availability list (format: ${fileType}). Extract all plant data into structured JSON.

Content:
${typeof content === 'string' ? content.substring(0, 15000) : JSON.stringify(content).substring(0, 15000)}`,
          },
        ],
        response_format: { type: 'json_object' },
        max_tokens: 4000,
        temperature: 0.1,
      });

      const result = JSON.parse(response.choices[0].message.content);
      return {
        success: true,
        plants: result.plants || [],
        warnings: result.parse_warnings || [],
        sourceFormat: result.source_format,
      };
    } catch (err) {
      console.error('[AI:parseNurseryList] Error:', err);
      return { success: false, error: err.message, plants: [] };
    }
  }

  // ─── AI Job Processor ──────────────────────────────────────────
  // Processes queued jobs from the ai_jobs table

  async processJob(job) {
    const start = Date.now();
    await this.db.query(
      "UPDATE ai_jobs SET status = 'processing', started_at = NOW(), attempts = attempts + 1 WHERE id = $1",
      [job.id]
    );

    let result;
    try {
      switch (job.job_type) {
        case 'plant_detection':
          result = await this.detectPlants(
            job.input_data.fileUrl,
            job.input_data.areaId,
            { location: job.input_data.location, usdaZone: job.input_data.usdaZone }
          );
          break;

        case 'design_generation':
          result = await this.generateDesign(job.design_id, job.input_data);
          break;

        case 'parse_nursery_list':
          result = await this.parseNurseryList(job.input_data.content, job.input_data.fileType);
          break;

        default:
          result = { success: false, error: `Unknown job type: ${job.job_type}` };
      }

      const status = result.success ? 'completed' : 'failed';
      await this.db.query(
        `UPDATE ai_jobs SET status = $1, output_data = $2, completed_at = NOW(), error_message = $3 WHERE id = $4`,
        [status, result, result.error || null, job.id]
      );

      return result;
    } catch (err) {
      await this.db.query(
        `UPDATE ai_jobs SET status = 'failed', error_message = $1, completed_at = NOW() WHERE id = $2`,
        [err.message, job.id]
      );
      return { success: false, error: err.message };
    }
  }

  // Poll and process pending jobs (run on interval or as worker)
  async processQueuedJobs(limit = 5) {
    const jobs = await this.db.getMany(
      `SELECT * FROM ai_jobs WHERE status = 'queued' AND attempts < max_attempts
       ORDER BY priority DESC, created_at ASC LIMIT $1`,
      [limit]
    );

    const results = [];
    for (const job of jobs) {
      const result = await this.processJob(job);
      results.push({ jobId: job.id, ...result });
    }
    return results;
  }

  // ─── Helpers ───────────────────────────────────────────────────

  async updateDesignStatus(designId, status, error = null) {
    await this.db.query(
      `UPDATE designs SET generation_status = $1, generation_error = $2,
       generation_completed_at = ${status === 'failed' ? 'NULL' : 'NOW()'}
       WHERE id = $3`,
      [status, error, designId]
    );
  }
}

// ═══════════════════════════════════════════════════════════════════
// DROP-IN REPLACEMENT FUNCTION
// Replace callManusAI() in filo-api-server.js with this:
// ═══════════════════════════════════════════════════════════════════

export function createAIHandler(db) {
  const ai = new AIService(db);

  return async function callAI(taskType, data) {
    switch (taskType) {
      case 'plant_detection':
        return ai.detectPlants(data.photoUrl, data.areaId, data);

      case 'design_generation':
        return ai.generateDesign(data.designId, data);

      case 'design_chat':
        return ai.processDesignChat(
          data.command,
          data.designId,
          data.currentDesign || [],
          data.availablePlants || []
        );

      case 'generate_narrative':
        return ai.generateNarrative(data);

      case 'parse_nursery_list':
        return ai.parseNurseryList(data.content, data.fileType);

      default:
        return { success: false, error: `Unknown task type: ${taskType}` };
    }
  };
}

// ═══════════════════════════════════════════════════════════════════
// EXPRESS ROUTES (mount for job polling status)
// ═══════════════════════════════════════════════════════════════════

export function mountAIRoutes(app, aiService, authenticate) {
  // Manual trigger to process queued jobs (for development/debugging)
  app.post('/api/ai/process-queue', authenticate, async (req, res) => {
    const results = await aiService.processQueuedJobs(req.body.limit || 5);
    res.json({ processed: results.length, results });
  });

  // Get AI service health
  app.get('/api/ai/health', async (req, res) => {
    const checks = {
      openai: !!config.openaiKey,
      replicate: !!config.replicateToken,
      imageProvider: config.imageProvider,
      gptModel: config.gptModel,
    };

    // Quick API check
    if (openai) {
      try {
        await openai.models.retrieve(config.gptModel);
        checks.openaiConnected = true;
      } catch {
        checks.openaiConnected = false;
      }
    } else {
      checks.openaiConnected = false;
    }

    res.json(checks);
  });
}
