// Copy this file to config.js and fill in the new Supabase project's values
// (Supabase → Project Settings → API Keys: the Project URL and the publishable / anon key).
// Both are public by design: every visitor's browser gets them, and RLS in schema.sql protects the data.
// config.js must be published with the site (GitHub Pages needs it), so don't gitignore it.
// NEVER put the secret / service_role key or the Gmail app password in this file.
window.KN_CONFIG = {
  url: 'https://ypsbdlnsfwyhifkfpawp.supabase.co',
  anonKey: 'sb_publishable_-waQ0TQFFdOdoBC7I0FKnQ_soOrlsBR',
};
