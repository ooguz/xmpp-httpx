# xmpp-httpx

[![CI](https://github.com/ooguz/xmpp-httpx/actions/workflows/ci.yml/badge.svg)](https://github.com/ooguz/xmpp-httpx/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/xmpp-httpx)](https://www.npmjs.com/package/xmpp-httpx)
[![API belgeleri](https://img.shields.io/badge/API-typedoc-blue)](https://ooguz.github.io/xmpp-httpx/)

[XEP-0332: HTTP over XMPP Transport](https://xmpp.org/extensions/xep-0332.html) belirtiminin TypeScript uygulaması — HTTP istek ve yanıtlarını XMPP üzerinden taşır; Node.js ve tarayıcılar için.

*[English documentation: README.md](README.md)*

XEP-0332 **Deferred** (askıya alınmış) durumda bir XEP'tir (v0.5.1). Bu kitaplık, belirtimin açıkça teşvik ettiği türden bir keşif amaçlı uygulamadır ve `httpx://kullanıcı@alan/yol` adreslerinde gezinen bir tarayıcının temeli olarak yazılmıştır.

**Belgeler** (İngilizce):

| Belge | İçerik |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Tasarım kuralları, modül haritası, istek yaşam döngüsü, yedi taşıma yönteminin tümü, hata ve güvenlik modelleri, yapılandırma başvurusu |
| [docs/protocol-notes.md](docs/protocol-notes.md) | Belirtimin belirsiz kaldığı her yerde verilen kararlar — birlikte çalışabilirliğin dayanağı |
| [docs/testing.md](docs/testing.md) | Üç vitest projesi, sahte oturum düzeneği, Prosody uçtan uca testleri, CI |
| [docs/browser-extension.md](docs/browser-extension.md) | Tarayıcı eklentisinin mimarisi: bağlantının nerede durduğu, işleme hattı, sekmeler, manifest stratejisi |
| [docs/gateway-cli.md](docs/gateway-cli.md) | `xmpp-httpx-gateway`: mevcut bir HTTP sunucusunu elle ya da Docker ile XMPP üzerine taşımak |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Sıradaki aşamalar ve işler |
| [docs/xep-0332-feedback.md](docs/xep-0332-feedback.md) | XSF standart süreci için uygulama deneyimi notları |
| [docs/interop.md](docs/interop.md) | Birlikte çalışabilirlik tablosu — denenmiş sunucular, çalışma ortamları, karşı uygulamalar |
| [examples/webext/README.md](examples/webext/README.md) | Tarayıcı eklentisini derleme/çalıştırma kılavuzu |
| [CHANGELOG.md](CHANGELOG.md) | Sürüm geçmişi |

## Neler var

- Protokolün hem **isteyen (istemci)** hem **yanıtlayan (sunucu)** tarafı
- XEP'teki **yedi gövde taşıma yönteminin tümü**: gömülü (inline) `text` / `xml` / `base64`, `chunkedBase64` ileti akışları, **IBB** ([XEP-0047](https://xmpp.org/extensions/xep-0047.html) — burada baştan yazıldı, çünkü xmpp.js tarafında bir paketi yok), **sipub** ([XEP-0137](https://xmpp.org/extensions/xep-0137.html), SI üzerinden, IBB akış yöntemiyle) ve asgari bir **Jingle** oturumu ([XEP-0166](https://xmpp.org/extensions/xep-0166.html)/[0234](https://xmpp.org/extensions/xep-0234.html), [XEP-0261](https://xmpp.org/extensions/xep-0261.html) IBB taşıması üzerinden). sipub ve jingle gönderirken isteğe bağlıdır (`preferredStreams`), alırken her zaman kabul edilir
- SHIM başlıkları ([XEP-0131](https://xmpp.org/extensions/xep-0131.html)), `httpx://` adres çözümleme, hizmet keşfi ([XEP-0030](https://xmpp.org/extensions/xep-0030.html)), varlık yetenekleri ([XEP-0115](https://xmpp.org/extensions/xep-0115.html)) ve durum bildirimlerinden (presence) beslenen yetenek önbelleği
- Gerçek WHATWG `Response` nesneleri döndüren, akışlı gövdeleri olan `fetch()` biçiminde bir arayüz
- Geçit (gateway) kurulumları için ters vekil sunucu işleyicisi (`xmpp-httpx/node`)
- Hazır bir geçit komut satırı aracı (`xmpp-httpx-gateway`) ve Docker imajı
- Yayımlanmış bir test düzeneği (`xmpp-httpx/testing`) — böylece sizin kodunuz da XMPP sunucusu olmadan test edilebilir

## Kurulum

```sh
npm install xmpp-httpx @xmpp/client
```

Yalnızca ESM; Node ≥ 20.10 ya da güncel bir tarayıcı. `@xmpp/client` (veya `@xmpp/component`) bir eş bağımlılıktır (peer dependency): bu kitaplık hiçbir zaman kendi başına bağlantı açmaz, siz ona bağlı bir oturum verirsiniz.

## İstemci

```js
import { client, xml } from "@xmpp/client";
import { HttpxClient, httpxFetch } from "xmpp-httpx";

const xmpp = client({ service: "wss://example.org/xmpp-websocket", username: "alice", password: "…" });
await xmpp.start();

// fetch() tarzı — gerçek bir WHATWG Response döner
const response = await httpxFetch("httpx://webserver@example.org/index.html", {
  session: xmpp,
});
console.log(response.status, await response.text());

// Daha alt seviye, tam denetim isteyen arayüz
const httpx = new HttpxClient(xmpp, { maxChunkSize: 4096 });
const resp = await httpx.request("webserver@example.org", {
  method: "POST",
  resource: "/api/items",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: "thing" }),
});
console.log(resp.statusCode, await resp.json());
```

Yanıt gövdeleri `ReadableStream<Uint8Array>` türündendir: büyük gövdeler, hangi mekanizmayla (gömülü, parçalı ileti, IBB) taşındığına bakılmaksızın kademeli olarak akar. `.text()`, `.json()`, `.bytes()`, `.xml()` ve `.formData()` yöntemlerinin hepsi vardır. XMPP düzeyindeki başarısızlıklar (yetkisiz, zaman aşımı, ulaşılamaz) `httpEquivalent` durum kodunu taşıyan bir `HttpxError` fırlatır; yanıt nesnesi yalnızca gerçek `<resp>` yapıtaşlarından (stanza) üretilir.

Her istek için `timeoutMs` (IQ süresi), `idleTimeoutMs` (akan bir gövdenin parçaları arasında izin verilen boşluk) ve `signal` verilebilir — genel bir süre sınırı için `AbortSignal.timeout(5000)` yeterlidir.

## Sunucu

```js
import { HttpxServer, allowList } from "xmpp-httpx";

const server = new HttpxServer(xmpp, {
  authorize: allowList(["alice@example.org", "*@trusted.example"]),
});

server.handle(async (req) => {
  // req: { from, to, method, resource, url, headers, body, accept }
  if (req.resource === "/hello") {
    return { status: 200, headers: { "content-type": "text/plain" }, body: "hi" };
  }
  // WHATWG Response nesneleri doğrudan çalışır — ters vekillik tek satır:
  return fetch(new URL(req.resource, "http://localhost:8080"));
});

server.start();
```

Yetkilendirme, XEP'in güvenlik değerlendirmeleri uyarınca **öntanımlı olarak her şeyi reddeder**; `allowAll()`, `allowList(...)` ya da kendi ilkenizi verin. `withRateLimit(handler, { ratePerSecond })` istek sahibi başına hız sınırlar; `negotiateContentType(req.headers.get("accept"), ["text/html", "application/json"])` ise q değerlerini yanlış yorumlamadan uygun temsili seçer.

Sunucu yanıt kodlamasını kendisi seçer: küçük gövdeler IQ'nun içine gömülür, büyükler IBB ya da parçalı iletilerle akar; istek sahibinin bildirdiği `maxChunkSize` ve mekanizma bayrakları gözetilir.

Geçit kurulumları için (gerçek bir web sunucusunun önünde duran bir XMPP bileşeni):

```js
import { component } from "@xmpp/component";
import { HttpxServer, allowAll } from "xmpp-httpx";
import { createOriginProxyHandler } from "xmpp-httpx/node";

const gw = component({ service: "xmpp://localhost:5347", domain: "web.example.org", password: "…" });
const server = new HttpxServer(gw, { authorize: allowAll() });
server.handle(createOriginProxyHandler("http://localhost:8080"));
server.start();
```

## Geçit komut satırı aracı

Var olan bir siteyi tek satır kod yazmadan XMPP üzerine taşımak:

```sh
XMPP_HTTPX_SECRET=… npx xmpp-httpx-gateway \
  --origin http://localhost:8080 \
  --service xmpp://xmpp.example.org:5347 \
  --domain web.example.org \
  --allow alice@example.org
```

Bu komut, HTTP sunucunuzu `httpx://web.example.org/…` adresinden sunar ve her istek sahibinin SASL ile doğrulanmış JID'ini `X-Httpx-From` başlığıyla iletir. İstemci hesabı kipi (`--jid`/`--password`) sunucu tarafında hiçbir yapılandırma gerektirmez. Yetkilendirme asla örtük değildir: ya `--allow <jid>` ya `--allow-all` verilir, yoksa geçit başlamayı reddeder. Her şey bir JSON yapılandırma dosyasında da durabilir (`--config`); öncelik sırası bayraklar > ortam değişkenleri > dosyadır. Ayrıntılar: [docs/gateway-cli.md](docs/gateway-cli.md).

`--static <dizin>` hiç HTTP sunucusu olmadan bir dizini sunar; `--rate`/`--burst` istek sahibi başına hız sınırlar (gerçek bir 429 ve `Retry-After` ile); `--metrics-port` Prometheus ölçümlerini ve bir `/healthz` ucunu açar.

Kurulum örneği olarak [`examples/docker/`](examples/docker/) üç kapsayıcılı bir yığın sunar — nginx kaynağı, Prosody, geçit — ve `docker compose up`'tan gezilebilir bir `httpx://web.localhost/` adresine iki komutta ulaşır.

## Geliştirme

```sh
npm install
npm run lint && npm run typecheck   # ESLint + tsc
npm test                            # vitest: birim + bellek içi tümleştirme testleri
npm run build                       # dist/ üretir
npm run demo                        # Prosody + örnek site, tek komut
```

Tümleştirme testleri her iki uç noktayı, hata enjeksiyonu yapabilen (parçaları sırasız teslim eden) bellek içi bir yapıtaşı yönlendiricisine karşı çalıştırır; böylece IBB akış denetimi dahil protokolün tamamı gerçek bir XMPP sunucusu olmadan sınanır. Bu düzenek **`xmpp-httpx/testing`** olarak yayımlanır, yani kendi işleyicilerinizi de aynı biçimde test edebilirsiniz:

```js
import { createSessionPair } from "xmpp-httpx/testing";

const [clientSession, serverSession] = createSessionPair("alice@example.org/pc", "web@example.org");
// …birine bir HttpxServer, diğerine bir HttpxClient koyup doğrulayın.
```

## Tarayıcı

[`examples/webext/`](examples/webext/) dizini, bu kitaplıkla `httpx://` adreslerinde gezinen, **Firefox ve Chromium için çalışan bir tarayıcı eklentisidir**: her sekmenin kendi geçmişi olan sekme çubuğu, adres çubuğu, geçmiş/yer imleri çekmecesi, omnibox anahtar sözcüğü (`httpx server@example.org/page` ⏎), Firefox'ta tıklanabilir `ext+httpx://` bağlantıları ve arındırılmış bir işleme hattı (DOMPurify + CSSOM tabanlı CSS arındırıcı → blob adresli alt kaynaklar → betik çalıştırmayan, yalıtılmış iframe); ayrıca formlar, indirmeler, sayfa başlıkları/simgeleri ve gerçek 304 doğrulaması yapan bir HTTP önbelleği. Derleme/çalıştırma yönergeleri için eklentinin kendi README dosyasına, gezilecek bir örnek site için `scripts/demo-gateway.mjs`'ye, tüm bunları gerçek Chromium'da sınamak için `npm run smoke` komutuna bakın.

## Yol haritası

Şimdiye dek tamamlananlar: yedi taşıma yönteminin tümüyle protokol, tarayıcı eklentisi ve geçit (komut satırı aracı, Docker imajı, ölçümler, dizin sunumu, hız sınırlama). Sıradakiler:

- Eklenti sayfası yerine gerçek bir `httpx://` adres çubuğu için bir Electron kabuğu
- Jingle S5B (XEP-0260) taşıma adayı uzlaşımı
- npm ve eklenti mağazalarına yayımlama

Tamamlananlar da dahil tüm ayrıntılar: [docs/ROADMAP.md](docs/ROADMAP.md).

## Lisans

AGPL-3.0-only
