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
      const vault = url.searchParams.get("vault") || "ObsidianSync";
      const redirectUri = `${url.origin}/callback`;
      const scope = encodeURIComponent("https://www.googleapis.com/auth/drive.file");
      
      const state = encodeURIComponent(vault);
      const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${env.GOOGLE_CLIENT_ID}&redirect_uri=${redirectUri}&response_type=code&scope=${scope}&access_type=offline&prompt=consent&state=${state}`;
      
      return Response.redirect(authUrl, 302);
    }

    // Endpoint 2: Google Callback
    if (url.pathname === "/callback") {
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      const state = url.searchParams.get("state") || "";

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
      let obsidianRedirect = `obsidian://obsync-auth?refresh_token=${encodeURIComponent(data.refresh_token)}&access_token=${encodeURIComponent(data.access_token)}&expires_in=${data.expires_in}`;
      if (state) {
        obsidianRedirect += `&vault=${encodeURIComponent(state)}`;
      }
      
      return new Response(
        `<html>
           <head>
             <meta name="viewport" content="width=device-width, initial-scale=1">
             <style>
               body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #f9f9f9; text-align: center; padding: 20px; }
               .btn { display: inline-block; padding: 15px 30px; font-size: 18px; color: white; background-color: #7b61ff; text-decoration: none; border-radius: 8px; font-weight: bold; margin-top: 20px; border: none; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
               p { color: #555; }
             </style>
           </head>
           <body>
             <h2>Authentication Successful!</h2>
             <p>Redirecting you back to Obsidian...</p>
             <p>If nothing happens (Firefox users), please tap the button below:</p>
             <a href="${obsidianRedirect}" class="btn">Open Obsidian</a>
             <script>
               setTimeout(() => {
                 window.location.href = "${obsidianRedirect}";
               }, 500);
             </script>
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
