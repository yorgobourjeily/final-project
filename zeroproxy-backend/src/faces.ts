import { HttpError } from './utils';

export const FACE_EMBEDDING_SIZE = 512;
export const FACE_MATCH_THRESHOLD = 0.4;

export function normalizedEmbedding(value: unknown): number[] {
  if (
    !Array.isArray(value) ||
    value.length !== FACE_EMBEDDING_SIZE ||
    value.some((item) => typeof item !== 'number' || !Number.isFinite(item))
  ) {
    throw new HttpError(400, `Send a ${FACE_EMBEDDING_SIZE}-value numeric face embedding.`);
  }
  const vector = value as number[];
  const magnitude = Math.hypot(...vector);
  if (magnitude < 1e-12) throw new HttpError(400, 'The face embedding cannot be zero.');
  return vector.map((item) => item / magnitude);
}