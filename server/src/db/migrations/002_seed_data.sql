-- ============================================================
-- Seed data: placeholder OAG key + demo tenant
-- ============================================================

-- Placeholder OAG API key row (inactive until configured via admin UI)
INSERT INTO shared_api_keys (service_name, display_name, key_enc, endpoint_url, is_active, notes)
VALUES (
    'oag',
    'OAG Flight Info API',
    '',
    'https://api.oag.com',
    FALSE,
    'Configure via Admin → API Keys. Obtain key from OAG portal. Set is_active=true once added.'
)
ON CONFLICT DO NOTHING;

-- Demo tenant for local development (resolves via X-Tenant-Slug: demo header in dev)
INSERT INTO tenants (
    slug,
    name,
    subdomain,
    logo_url,
    primary_colour,
    terms_url,
    support_email,
    policy_api_mode,
    cover_benefit_name,
    modulr_mode,
    token_ttl_days,
    delay_threshold_minutes,
    min_hours_before_dep,
    is_active
) VALUES (
    'demo',
    'Demo Insurance Co.',
    'demo.localhost',
    NULL,
    '#1a56db',
    NULL,
    'support@demo.localhost',
    'stub',
    'Flight Delay',
    'stub',
    7,
    180,
    24,
    TRUE
)
ON CONFLICT (slug) DO NOTHING;
