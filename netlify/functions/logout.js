import { serialize } from 'cookie';

export default function handler(req, res) {
  res.setHeader('Set-Cookie', serialize('auth_token', '', { maxAge: -1, path: '/' }));
  res.redirect(302, '/');
}