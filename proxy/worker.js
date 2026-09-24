// Cloudflare Worker Script for ObSync
// Deploy this to Cloudflare Workers.
// Set environment variables (secrets) in Cloudflare:
// - GOOGLE_CLIENT_ID
// - GOOGLE_CLIENT_SECRET

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Endpoint 1: Initiate Login
    if (url.pathname === "/login") {
      const redirectUri = `${url.origin}/callback`;
      const scope = encodeURIComponent("https://www.googleapis.com/auth/drive.file");
      const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${env.GOOGLE_CLIENT_ID}&redirect_uri=${redirectUri}&response_type=code&scope=${scope}&access_type=offline&prompt=consent`;
      
      return Response.redirect(authUrl, 302);
    }

    // Endpoint 2: Google Callback
    if (url.pathname === "/callback") {
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      if (error) {
        return new Response(`Authentication Error: ${error}`, { status: 400 });
      }

      if (!code) {
        return new Response("No authorization code provided.", { status: 400 });
      }

      const redirectUri = `${url.origin}/callback`;
      
      const body = new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      });

      const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });

      if (!tokenRes.ok) {
        const errText = await tokenRes.text();
        return new Response(`Failed to exchange code for tokens: ${errText}`, { status: 500 });
      }

      const data = await tokenRes.json();
      
      // Redirect back to Obsidian using custom URI scheme
      // Note: The plugin must register 'obsidian://obsync-auth'
      const obsidianRedirect = `obsidian://obsync-auth?refresh_token=${encodeURIComponent(data.refresh_token)}&access_token=${encodeURIComponent(data.access_token)}&expires_in=${data.expires_in}`;
      
      return new Response(
        `<html>
           <body>
             <p>Authentication successful! Redirecting back to Obsidian...</p>
             <p>If you are not redirected automatically, <a href="${obsidianRedirect}">click here</a>.</p>
             <script>window.location.href = "${obsidianRedirect}";</script>
           </body>
         </html>`, 
         { headers: { "Content-Type": "text/html" } }
      );
    }

    // Endpoint 3: Refresh Token
    if (url.pathname === "/refresh" && request.method === "POST") {
      try {
        const reqBody = await request.json();
        const refreshToken = reqBody.refresh_token;

        if (!refreshToken) {
          return new Response("Missing refresh_token", { status: 400 });
        }

        const body = new URLSearchParams({
          client_id: env.GOOGLE_CLIENT_ID,
          client_secret: env.GOOGLE_CLIENT_SECRET,
          refresh_token: refreshToken,
          grant_type: "refresh_token",
        });

        const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: body.toString(),
        });

        if (!tokenRes.ok) {
          const errText = await tokenRes.text();
          return new Response(`Failed to refresh token: ${errText}`, { status: 500 });
        }

        const data = await tokenRes.json();
        return new Response(JSON.stringify({
          access_token: data.access_token,
          expires_in: data.expires_in
        }), { 
          headers: { "Content-Type": "application/json" }
        });
      } catch (e) {
        return new Response(`Error: ${e.message}`, { status: 500 });
      }
    }

    return new Response("ObSync Auth Proxy Worker is running.", { status: 200 });
  }
};
