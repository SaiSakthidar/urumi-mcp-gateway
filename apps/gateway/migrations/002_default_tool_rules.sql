-- Default tool permissions: members can read the store but not change it.
-- Admins are not affected by rules (see src/core/permissions.ts).
INSERT INTO tool_rules (role, upstream_slug, tool_pattern, effect) VALUES
  ('member', 'woo', 'create_product', 'deny'),
  ('member', 'woo', 'update_order_status', 'deny');
