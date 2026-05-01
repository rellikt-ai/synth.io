const jwt = require('jsonwebtoken');

exports.handler = async (event, context) => {
  const { code, state } = event.queryStringParameters;
  const storedState = event.cookies?.discord_state;

  if (!code || state !== storedState) {
    return { statusCode: 302, headers: { Location: `${process.env.BASE_URL}/?error=auth_failed` } };
  }

  const redirectUri = `${process.env.BASE_URL}/.netlify/functions/callback`;
  const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.DISCORD_CLIENT_ID,
      client_secret: process.env.DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri
    })
  });

  if (!tokenRes.ok) return { statusCode: 302, headers: { Location: `${process.env.BASE_URL}/?error=token_failed` } };
  const { access_token } = await tokenRes.json();

  const userRes = await fetch('https://discord.com/api/users/@me', {
    headers: { Authorization: `Bearer ${access_token}` }
  });

  if (!userRes.ok) return { statusCode: 302, headers: { Location: `${process.env.BASE_URL}/?error=user_failed` } };
  const user = await userRes.json();

  const session = jwt.sign(
    { id: user.id, username: user.username, avatar: user.avatar, discriminator: user.discriminator },
    process.env.SESSION_SECRET,
    { expiresIn: '7d' }
  );

  return {
    statusCode: 302,
    headers: {
      'Location': `${process.env.BASE_URL}/dashboard.html`,
      'Set-Cookie': `auth_token=${session}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800`
    }
  };
};