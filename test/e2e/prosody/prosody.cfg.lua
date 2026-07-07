-- Prosody configuration for the xmpp-httpx E2E suite.
-- Deliberately insecure: plaintext auth over unencrypted websocket,
-- localhost-only, throwaway container.

admins = {}

-- Required for prosodyctl status (the compose healthcheck).
pidfile = "/var/run/prosody/prosody.pid"

-- Bind HTTP (websocket) to all interfaces so Docker port mapping reaches it.
http_interfaces = { "*", "::" }

modules_enabled = {
    "roster",
    "saslauth",
    "disco",
    "ping",
    "websocket",
}

-- Tests run over ws:// with PLAIN auth.
c2s_require_encryption = false
s2s_require_encryption = false
allow_unencrypted_plain_auth = true
consider_websocket_secure = true

authentication = "internal_plain"

component_ports = { 5347 }
component_interface = "*"

VirtualHost "localhost"

Component "httpx.localhost"
    component_secret = "e2e-secret"
