/** S9R/1 · biblioteca de formato de replay. Aislada: no depende del worker ni del motor. */
export * from "./errors.js";
export { PREFERRED_ALGO, algoAvailable, type Algo } from "./codec.js";
export { S9rWriter, type WriterOptions, type WriteSummary } from "./writer.js";
export { S9rReader, type OpenOptions } from "./reader.js";
export { verifyFile, scanPartial, type VerifyResult } from "./verify.js";
export { publishPartial, publishPair, discardPartial, type PublishPair } from "./publish.js";
export { nodeFs, type S9rFs, type S9rFile } from "./io.js";
export type { Kind, IndexDoc, FragmentEntry } from "./format.js";
