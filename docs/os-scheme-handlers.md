# Registering `httpx:` with the operating system

The desktop shell already accepts a URL as an argument and routes it into the
running instance. That is the hard half, and it is done
([electron-shell.md](electron-shell.md)). What remains is telling the OS that
`httpx:` belongs to it. This note records what each platform needs, and what is
deliberately not built yet.

## The shell side (done)

```
electron . httpx://web.example.org/page     # first launch: opens with that URL
electron . httpx://web.example.org/other    # while running: opens a tab in it
```

Three paths feed one function:

- argv on first launch: `httpxUrlFromArgv(process.argv)`.
- `second-instance`: Linux and Windows deliver a repeat launch here, which
  is why the shell takes a single-instance lock. Verified with a real double
  launch.
- `open-url`: macOS delivers handler URLs this way instead of in argv.

Electron also offers `app.setAsDefaultProtocolClient("httpx")`, which writes the
registration at runtime. It is *not* called today: doing it from a source
checkout would register a path that stops existing, and a scheme registration
that points at a deleted binary is worse than none.

## Linux

A `.desktop` entry with a `MimeType` of `x-scheme-handler/httpx`:

```ini
[Desktop Entry]
Type=Application
Name=httpx browser
Exec=/opt/httpx-shell/httpx-shell %u
Terminal=false
MimeType=x-scheme-handler/httpx;
```

Installed to `~/.local/share/applications/httpx-shell.desktop`, then:

```sh
update-desktop-database ~/.local/share/applications
xdg-mime default httpx-shell.desktop x-scheme-handler/httpx
```

`%u` is what passes the URL as an argument. Note that xdg-open and each desktop
environment consult this independently of browsers: Firefox's own
`network.protocol-handler.expose.httpx` pref decides whether *Firefox* hands the
URL to the OS at all, and Chromium prompts the user the first time.

## Windows

A registry key under `HKCU\Software\Classes\httpx`:

```
HKCU\Software\Classes\httpx
    (Default)          = "URL:httpx Protocol"
    URL Protocol       = ""
HKCU\Software\Classes\httpx\shell\open\command
    (Default)          = "\"C:\\Program Files\\httpx-shell\\httpx-shell.exe\" \"%1\""
```

`URL Protocol` (with an empty value) is the flag that makes the key a scheme
handler rather than a file association. `%1` carries the URL. Squirrel and
electron-builder both write this from an installer; doing it by hand is only for
development.

## macOS

Declarative, in the app bundle's `Info.plist`; nothing at runtime:

```xml
<key>CFBundleURLTypes</key>
<array><dict>
  <key>CFBundleURLName</key><string>httpx</string>
  <key>CFBundleURLSchemes</key><array><string>httpx</string></array>
</dict></array>
```

Launch Services picks it up when the bundle is installed, and delivers URLs
through `open-url`, which the shell already handles.

## Why this is not wired up yet

All three want a packaged application, and packaging is the open item: an
unpackaged `npm start` has no stable path (Linux, Windows) and no bundle
(macOS). The sequence, when someone picks it up:

1. `electron-builder` config producing an AppImage/deb, an NSIS installer, and a
   `.app`.
2. Let the packagers write the registration: electron-builder's `protocols`
   field emits the plist entry, the registry keys and the `.desktop` MimeType
   from one declaration.
3. Only then consider `setAsDefaultProtocolClient` for the "make default"
   button, where the path is real.

## The security question packaging raises

A registered scheme means any web page can hand your desktop app a URL:
`<a href="httpx://…">` in a hostile page, and the OS launches the shell. The
shell's defences already assume hostile input (the CSP, the sandboxed content
views, no Node in page renderers), and `httpxUrlFromArgv` only accepts strings
starting with `httpx://`, but two things deserve attention before shipping a
registration:

- Argument injection. Only the URL is taken from argv, and only if it parses;
  nothing from a URL reaches a shell command. Worth keeping true: never pass a
  handler URL to anything that spawns a process.
- Silent launch. Opening an app is itself a signal to an attacker (it proves
  the app is installed). Chromium's and Firefox's first-use prompts mitigate
  this, and nothing on our side should bypass them.
