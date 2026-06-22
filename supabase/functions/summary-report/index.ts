const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-demo-token",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

Deno.serve((req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: corsHeaders,
    });
  }

  return Response.json(
    {
      ok: true,
      service: "ai-seo-analyst",
      scenario: "summary-report",
      mode: "mock",
      message: "Supabase backend core is working",
    },
    {
      headers: corsHeaders,
    },
  );
});
