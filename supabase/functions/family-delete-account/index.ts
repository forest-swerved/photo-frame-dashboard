import { createClient } from 'npm:@supabase/supabase-js@2.118.0';
import { createDeleteAccountHandler } from './handler.mjs';

// The service-role key is provided by the Supabase Edge runtime only. Do not
// copy it into the Vercel project, app build, function requests, or logs.
const handler = createDeleteAccountHandler({ createClient, env: {
  SUPABASE_URL: Deno.env.get('SUPABASE_URL'),
  SUPABASE_ANON_KEY: Deno.env.get('SUPABASE_ANON_KEY'),
  SUPABASE_SERVICE_ROLE_KEY: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
} });
Deno.serve(handler);
