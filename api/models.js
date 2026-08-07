import { handleModels } from '../scripts/server.mjs';

export default function handler(req, res) {
  return handleModels(req, res);
}
