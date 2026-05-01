const crypto = require('crypto');

exports.handler = async (event, context) => {
  const state = crypto.randomUUID();
  const redirectUri = `${process.env.BASE_URL}/.netlify/functions/callback`;
  
  const params = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'identify guilds',
    state
  });

  return {
    statusCode: 302,
    headers: {
      'Location': `https://discord.com/api/oauth2/authorize?${params}`,
      'Set-Cookie': `discord_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`
    }
  };
};