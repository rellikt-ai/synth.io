import jwt from 'jsonwebtoken';
import { parse } from 'cookie';

export default function handler(req, res) {
  const cookies = parse(req.headers.cookie || '');
  const token = cookies.auth_token;

  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  try {
    const decoded = jwt.verify(token, process.env.SESSION_SECRET);
    res.status(200).json(decoded);
  } catch {
    res.status(401).json({ error: 'Invalid session' });
  }
}