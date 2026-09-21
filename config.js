'use strict';
// Public configuration only. The anon key is safe in the page: every pd_ table
// is behind sign-in + row-level security, and the Unleashed token lives
// server-side (Edge Function secrets), never here.
const CONFIG = {
  SUPABASE_URL: 'https://xwijlhzmjurizyrgrwco.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh3aWpsaHptanVyaXp5cmdyd2NvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA0NDE5NTIsImV4cCI6MjA5NjAxNzk1Mn0.3KZ0DZ1w6TaqceAH9h65Af0xu8zYZ-jDBTyffITwXpU',
};
