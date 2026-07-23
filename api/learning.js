import { handleLearning } from '../scripts/server.mjs';

export { handleLearning };

export default function handler(req, res) {
  return handleLearning(req, res);
}
