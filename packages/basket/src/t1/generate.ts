import type { TaskInstance } from "../types.js";
import { deriveSeed, mulberry32, randChoice, randHex, randInt, type Rng } from "../seed.js";

export interface T1Expected {
  tracking_id: string;
  origin_city: string;
  destination_city: string;
  weight_kg: number;
  status: string;
  priority: string;
}

export const T1_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  additionalProperties: false,
  properties: {
    tracking_id: { type: "string" },
    origin_city: { type: "string" },
    destination_city: { type: "string" },
    weight_kg: { type: "number" },
    status: { type: "string", enum: ["pending", "in_transit", "delivered", "delayed"] },
    priority: { type: "string", enum: ["standard", "express"] },
  },
  required: ["tracking_id", "origin_city", "destination_city", "weight_kg", "status", "priority"],
} as const;

const CITIES = [
  "Denver",
  "Lisbon",
  "Nairobi",
  "Osaka",
  "Auckland",
  "Marseille",
  "Toronto",
  "Cebu",
  "Gdansk",
  "Recife",
  "Perth",
  "Tallinn",
];

const STATUSES = T1_SCHEMA.properties.status.enum;
const PRIORITIES = T1_SCHEMA.properties.priority.enum;

const FILLER_TOPICS = [
  "Warehouse staff rotate through three shifts to keep the sorting floor moving around the clock.",
  "Customs paperwork is filed electronically at least six hours before a container reaches the port.",
  "Drivers on the regional routes complete a vehicle inspection checklist before every departure.",
  "Packaging standards require corner protectors on any pallet exceeding one meter in height.",
  "The regional hub consolidates smaller parcels into containerized loads twice a day.",
  "Temperature-sensitive cargo is logged separately from the general freight manifest.",
  "A dedicated compliance team audits a sample of manifests each week for labeling accuracy.",
  "Loading dock scheduling is coordinated through a shared calendar visible to all shift leads.",
  "Insurance claims for damaged freight are processed by a separate regional office.",
  "Seasonal volume increases are handled by temporary staff hired through a regional agency.",
  "Fuel surcharges are recalculated monthly based on a published regional index.",
  "Route planning software accounts for known congestion windows near the port entrances.",
  "Pallet weights are cross-checked against the manifest during the final loading pass.",
  "Damaged packaging is photographed and logged before a shipment is allowed to continue.",
  "Cross-docking reduces the average dwell time for freight that is already sorted upon arrival.",
];

function buildFillerParagraphs(rng: Rng, count: number): string[] {
  const paragraphs: string[] = [];
  for (let p = 0; p < count; p++) {
    const sentenceCount = randInt(rng, 3, 5);
    const sentences: string[] = [];
    for (let s = 0; s < sentenceCount; s++) {
      sentences.push(randChoice(rng, FILLER_TOPICS));
    }
    paragraphs.push(sentences.join(" "));
  }
  return paragraphs;
}

export function generateT1Instance(parentSeed: number, index: number): TaskInstance<T1Expected> {
  const seed = deriveSeed(parentSeed, "T1", index);
  const rng = mulberry32(seed);

  const [origin, destination] = (() => {
    const pool = [...CITIES];
    const o = randChoice(rng, pool);
    const remaining = pool.filter((c) => c !== o);
    const d = randChoice(rng, remaining);
    return [o, d];
  })();

  const expected: T1Expected = {
    tracking_id: `SH-${randHex(rng, 6).toUpperCase()}`,
    origin_city: origin,
    destination_city: destination,
    weight_kg: randInt(rng, 5, 500),
    status: randChoice(rng, STATUSES),
    priority: randChoice(rng, PRIORITIES),
  };

  const openingFiller = buildFillerParagraphs(rng, 5);
  const factsParagraph =
    `Shipment ${expected.tracking_id} originated in ${expected.origin_city} and is destined for ` +
    `${expected.destination_city}. The consignment weighs ${expected.weight_kg} kilograms and has been ` +
    `assigned ${expected.priority} priority. Current tracking status shows the shipment as ${expected.status}.`;
  const closingFiller = buildFillerParagraphs(rng, 5);

  const document = [
    "Regional Logistics Operations — Shift Handover Notes",
    ...openingFiller,
    factsParagraph,
    ...closingFiller,
  ].join("\n\n");

  const instruction =
    "Read the operations report below. Extract the shipment record it describes into a single JSON " +
    "object matching this JSON Schema exactly, with no additional properties and no explanatory text " +
    `outside the JSON object:\n\n${JSON.stringify(T1_SCHEMA, null, 2)}\n\n---\n\n${document}`;

  return {
    task_class: "T1",
    instance_id: `T1-${index.toString().padStart(2, "0")}`,
    seed,
    prompt: instruction,
    params: { temperature: 0, max_tokens: 512 },
    expected,
  };
}

export function generateT1Instances(parentSeed: number, count: number): TaskInstance<T1Expected>[] {
  return Array.from({ length: count }, (_, i) => generateT1Instance(parentSeed, i));
}
