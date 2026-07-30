-- Prosody for the xmpp-httpx compose example.
--
-- Demo-grade on purpose: plaintext auth over an unencrypted websocket so the
-- WebExtension can connect to ws://localhost:5280 without certificates. A real
-- deployment uses TLS (wss://) and a proper authentication backend.

admins = {}
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

c2s_require_encryption = false
s2s_require_encryption = false
allow_unencrypted_plain_auth = true
consider_websocket_secure = true

authentication = "internal_plain"

component_ports = { 5347 }
component_interface = "*"

VirtualHost "localhost"

-- The gateway connects here and serves httpx://web.localhost/…
Component "web.localhost"
    component_secret = "compose-secret"
