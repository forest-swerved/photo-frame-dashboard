import { createClient } from 'npm:@supabase/supabase-js@2.118.0';
import { createMediaObjectHandler } from './handler.mjs';
// Administrative credentials stay in Edge. Vercel holds only a dedicated HMAC
// capability restricted by this handler to one private media bucket.
const client = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } });
Deno.serve(createMediaObjectHandler({ storage: client.storage, secret: Deno.env.get('FAMILY_MEDIA_GATEWAY_KEY') }));
