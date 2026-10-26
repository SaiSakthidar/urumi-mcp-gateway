-- Members can read any store but not change it, for hosted servers and every
-- provisioned store too ("*" matches any server slug).
INSERT INTO tool_rules (role, upstream_slug, tool_pattern, effect) VALUES
  ('member', '*', 'create_product', 'deny'),
  ('member', '*', 'update_order_status', 'deny');
