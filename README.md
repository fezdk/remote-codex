# Remote Codex

Et browser-UI til dine eksisterende lokale Codex-sessioner. Browseren forbinder til en lille Node-server, som taler direkte med din kørende Codex-daemon. Codex arbejder fortsat på din maskine med din eksisterende konto og konfiguration.

Se også [undersøgelsen af T3 Code](docs/t3-code-research.md) som reference for arkitektur, enhedsparring og fjernadgang. Projektet fokuserer fortsat på Codex alene.

## Start

Kræver Node.js 18.19+, npm og en kørende Codex app-server-daemon med en allerede konfigureret Codex-konto. Git skal være installeret for at bruge Git-fanen og køre Git-testene. Integrationen er verificeret mod **Codex 0.153.4 på Linux**. Protokollen er eksperimentel og versionsafhængig; andre Codex-versioner og operativsystemer er ikke garanteret at fungere.

Kør kommandoerne fra projektets rodmappe. Der er intet frontend-build-trin:

```bash
npm ci
npm start
```

Serveren lytter på **0.0.0.0:4310** (alle IPv4-netværksinterfaces). Åbn **http://127.0.0.1:4310** lokalt eller `http://MASKINENS-IP:4310` fra en anden pc. Netværksadresser udskrives ved start. Ved første start oprettes en adgangsnøgle i `.remote-codex/access-key` med filrettigheder `0600`. Vis den i din lokale terminal, og indsæt den på login-skærmen:

```bash
cat .remote-codex/access-key
```

Webserveren genbruger daemonen. Den starter eller genstarter ikke Codex, og den opretter ikke test-sessioner. Hvis der ikke allerede kører en daemon, kan du starte den med:

```bash
codex app-server daemon start
```

Stop webserveren med Ctrl+C; den eksisterende Codex-daemon og dens arbejde fortsætter. Webserveren skal køre, mens du bruger browseren. `npm start` installerer ingen systemtjeneste.

## Funktioner

- Sessionsliste med søgning, pagination, projektmappe og status.
- Tilslutning til eksisterende aktive eller gemte sessions via `thread/resume`, uden konfigurationsoverskrivelser.
- Samtalehistorik med tidligere sider, live-beskeder, kodeblokke, kommandooutput, filændringer og agentaktivitet.
- Nye sessions i en lokal projektmappe.
- Beskeder til en session. Under en aktiv tur sætter Enter beskeden i Codex-serverens vedvarende kø; knappen **Steer** sender en instruktion til den aktive tur.
- Synlig beskedkø med redigering, annullering og **Send som steer**. Pil-op i et tomt chatfelt henter seneste købesked til redigering eller seneste sendte tekst som en ny kladde.
- Dansk/engelsk sprogskifter og lyst/mørkt tema, gemt i browseren. Temaet følger systemet, indtil du vælger selv. Grøn/rød forbindelsesprik.
- Separat filpanel med fanerne **Codex** og **Git**, filliste og farvet diff.
- Stop af aktiv tur.
- Engangsgodkendelse, afvisning og annullering af kommando- og filanmodninger, når daemonen leverer dem til denne klient.
- Svar på `item/tool/requestUserInput`. Forslag i asynkrone spørgsmål kan indsættes som beskeder.
- Automatisk genforbindelse, genindlæsning af historik og gendannelse af abonnementer. Sendte handlinger genafspilles aldrig automatisk.
- Mobilvisning og sessionens adresse i URL-fragmentet. Kladder bevares ved sessionsskift i samme side; de gemmes ikke ved genindlæsning.

## Beskedkø, filpanel og oversættelser

Køen bruger de eksperimentelle `thread/queue/*`-metoder i Codex 0.153.4. Den tilhører Codex-serveren og genindlæses efter genforbindelse eller sideopdatering. Codex starter købeskeder, når sessionen bliver ledig. Redigering tager først beskeden ud af køen, så den ikke afsendes, mens du retter den. En allerede modtaget besked ændres ikke i historikken; pil-op gør dens tekst klar til en ny afsendelse. Beskeder under afsendelse vises uden redigeringsknapper. Ved uklar leveringsstatus gensendes intet automatisk. Kladder og tekst taget ud af køen er kun gemt i den åbne browserside.

**Codex** opsummerer gennemførte `fileChange`-elementer i den valgte sessions historik. Gentagne ændringer samles pr. fil; linjetal er summen af patches, ikke et netto-diff. Ændringer lavet gennem shell-kommandoer eller andre værktøjer vises kun her, hvis Codex registrerer dem som filændringer. **Git** viser projektets aktuelle staged, unstaged og untracked ændringer, også fra andre sessioner og manuelle rettelser. Visningen læser kun Git og ændrer hverken index eller filer. Projekter uden Git får en forklaring. Git-visningen forudsætter, at projektets filer er lokale på webserverens maskine.

Filpanelet opdateres ved gennemførte filændringer og ture; brug opdateringsknappen for eksterne Git-ændringer. Meget store historier og diff begrænses, og afkortning markeres i UI’et. Binære untracked filer og symlink-indhold åbnes ikke som tekst.

Alle faste UI-tekster ligger i `public/locales.js`. Tilføj en sprogkode i `languages` og en tilsvarende ordbog i `messages` for flere sprog. Samtaleindhold, filnavne og originale Codex-fejl oversættes ikke.

## Adgang fra en anden maskine

Webserveren lytter som standard på alle IPv4-netværksinterfaces. Brug `http://MASKINENS-IP:4310` fra en anden computer; mulige netværksadresser udskrives i terminalen ved start. Login kræves også ved netværksadgang. Uden en eksplicit `REMOTE_CODEX_ORIGIN` accepteres localhost og maskinens egne interface-IP-adresser; en fremmed Host eller en cross-origin-anmodning afvises stadig.

For kun at lytte lokalt kan du bruge `REMOTE_CODEX_HOST=127.0.0.1 npm start`. En SSH-tunnel kan derefter give en anden computer adgang. Kør på computeren med browseren:

```bash
ssh -N -L 4310:127.0.0.1:4310 BRUGERNAVN@CODEX-MASKINE
```

Åbn derefter `http://127.0.0.1:4310` i browseren, og brug samme adgangsnøgle.

Til en eksisterende VPN eller en HTTPS-reverse-proxy konfigureres lytteadresse og browserens præcise origin. Eksempel bag en HTTPS-proxy på samme maskine:

```bash
REMOTE_CODEX_HOST=127.0.0.1 REMOTE_CODEX_ORIGIN=https://codex.example.com npm start
```

Proxyen skal bevare `Host`-headeren, videresende til `127.0.0.1:4310` og slå buffering fra for `/api/events` (Server-Sent Events). Ingen browser-WebSocket er nødvendig. Brug HTTPS ved netværksadgang; send ikke adgangsnøglen over et ubeskyttet offentligt HTTP-netværk. Projektet konfigurerer ikke automatisk DNS, certifikater, tunnel eller VPN.

## Konfiguration

Indstillinger læses fra processens miljø ved opstart. `.env`-filer indlæses ikke automatisk. Sæt variablerne i din shell eller din procesmanager. Eksempel med lokal binding og en anden port:

```bash
REMOTE_CODEX_HOST=127.0.0.1 REMOTE_CODEX_PORT=4400 npm start
```

| Miljøvariabel | Standard / funktion |
| --- | --- |
| `REMOTE_CODEX_HOST` | `0.0.0.0` (alle IPv4-interfaces). Sæt `127.0.0.1` for kun lokal adgang. |
| `REMOTE_CODEX_PORT` | `4310` |
| `REMOTE_CODEX_ORIGIN` | Valgfri præcis browser-origin, fx `https://codex.example.com`, uden afsluttende `/`. Bruges ved eget domæne eller reverse-proxy; ellers accepteres maskinens lokale IP-adresser og localhost. |
| `REMOTE_CODEX_TOKEN` | Valgfri adgangsnøgle på mindst 24 tegn. Ellers bruges den lokalt genererede fil. |
| `CODEX_APP_SERVER_SOCKET` | `$CODEX_HOME/app-server-control/app-server-control.sock`, ellers `~/.codex/app-server-control/app-server-control.sock`. |
| `CODEX_APP_SERVER_URL` | Valgfri eksisterende `ws://127.0.0.1:PORT` eller `wss://…` server i stedet for Unix-socket. |
| `CODEX_APP_SERVER_TOKEN` | Valgfrit upstream bearer-token. Kun på serversiden. |
| `CODEX_HOME` | Valgfri Codex-hjemmemappe, som bruges til at finde standard-socketen. Ellers bruges brugerens hjemmemappe plus `.codex`. |

Browser-login anvender en HttpOnly, SameSite=Strict-cookie med 12 timers levetid; `Secure` sættes ved HTTPS-origin. Adgangsnøgler lægges ikke i URL'er eller browserens localStorage. API'et validerer Host, Origin og JSON-indholdstype, begrænser loginforsøg og eksponerer kun de implementerede sessionshandlinger. Samtaletekst indsættes som DOM-tekst, ikke rå HTML. API-svar og samtaler caches ikke.

Genstart af webserveren logger browserne ud. For at rotere nøglen kan du stoppe webserveren, fjerne `.remote-codex/access-key` og starte den igen (eller ændre `REMOTE_CODEX_TOKEN`). Adgang til UI'et giver kontrol over de sessions, som den tilsluttede daemon stiller til rådighed.

## Privatliv og repository-indhold

Repositoryet indeholder kildekode, dokumentation og syntetiske testdata. Det kræver ingen medfølgende API-nøgler eller konto-oplysninger. Codex-kontoen og modeladgangen håndteres af den eksisterende daemon. Browserens adgangsnøgle er en separat nøgle til denne webserver.

`.gitignore` udelukker blandt andet:

- Hele `.remote-codex/`, inklusive `.remote-codex/access-key`.
- Miljøfiler som `.env` og `.env.production`, lokale indstillingsfiler og privat nøglemateriale.
- Lokale Codex-, agent- og editorindstillinger.
- Logs, browsertraces, screenshots i testmapperne og andre genererede testrapporter.
- Afhængigheder og build-output.

Eventuelle `.env.example`- og `.env.sample`-filer kan versionsstyres, men må kun indeholde pladsholdere. De faste adgangsnøgler og adresser i testkoden er offentlige, syntetiske fixtures; de må ikke bruges til en rigtig installation. Dokumentationens værtsnavne, brugernavne og stier er generiske eksempler.

UI'et viser efter login rigtige projektstier, samtaler, værktøjsoutput og filindhold. Disse data kan være private. Git-ignore-regler beskytter mod utilsigtet versionsstyring af de angivne filer; de er ikke et filter på Codex-historik eller en garanti for, at vilkårlige fremtidige filer er ufølsomme. Undgå derfor at lægge produktionslogs og screenshots med sessionsindhold i kildekodemapperne.

Kontrollér ignore-reglen og det materiale, der er valgt til et commit, med:

```bash
git check-ignore -v .remote-codex/access-key
git status --short
git diff --cached
```

## Projektstruktur

```text
public/                 HTML, CSS og browserens JavaScript-moduler
  app.js                Sessionsnavigation, samtaler og godkendelser
  state.js              Historik og behandling af live-events
  queue.js              Beskedkø, redigering og genafsendelse
  changes.js            Filpanel og diffvisning
  locales.js            Oversættelser
  i18n.js               Oversættelsesfunktioner og sprogkontroller
  preferences.js        Tema og sprog før første visning
server/
  index.js              Opstart, adgangsnøgle og miljøkonfiguration
  http.js               Browser-API, statiske filer, login og SSE
  codex.js              Forbindelse til Codex-daemonen
  changes.js            Opsummering af Codex-ændringer og læsning af Git
test/                   Unit-, integrations- og browsertests
docs/                   Arkitekturundersøgelse og referencer
```

## Arkitektur og protokol

```text
Browser ── HTTP(S), cookie, SSE ── Node-webserver
                                       │
                            JSON-RPC / WebSocket
                                       │
                         Eksisterende Codex-daemon
                              på Unix-socket
```

`server/codex.js` håndterer handshake, RPC-ID'er, serveranmodninger og reconnect. `server/http.js` afgrænser browser-API'et, godkendelser og login. `public/state.js` samler sessions- og turn-events. Frontenden er almindelig JavaScript og CSS uden build-trin; `ws` er eneste runtime-afhængighed.

Unix-socketen bruger et HTTP WebSocket Upgrade-håndtryk. `perMessageDeflate` er bevidst deaktiveret: den installerede daemon lukkede forbindelsen, når klienten tilbød komprimering. `codex app-server proxy` er en byte-proxy til dette transportlag, ikke et JSONL-interface.

Der oprettes ét delt upstream-abonnement pr. åbnet session. Flere browserfaner ser samme serveranmodninger; en anmodning kan kun besvares én gang. Lukning af en browser stopper ikke Codex. Upstream-abonnementer bliver i broen frem til dens genstart for at bevare live-aktivitet og ventende anmodninger.

Den officielle [Codex App Server-dokumentation](https://learn.chatgpt.com/docs/app-server) beskriver protokollen. Lokale protokoltyper kan genereres for din installerede version:

```bash
codex app-server generate-ts --experimental --out /tmp/remote-codex-protocol
```

## Afgrænsning

Dette er en selvstændig browserklient, ikke en integration i chatgpt.com eller OpenAI's Remote Control-relay. Den tilslutter sig den daemon, du angiver. Sessions i en separat Codex-proces er ikke automatisk samme live-runtime; gemte sessions kan vises, men for fælles live-kontrol skal klienterne bruge samme app-server.

UI'et bevarer sessionens godkendelsespolitik og reviewer. Anmodninger, som behandles af automatisk review eller kun vises i en anden klient, ændres ikke til browsergodkendelser. Udvidede permission grants, MCP-elicitation, dynamiske klientværktøjer og andre ikke-understøttede serveranmodninger henvises til den oprindelige klient. Uploads, voice, interaktiv terminal og fuld app-paritet er ikke implementeret. Markdown-visningen understøtter tekst, links, fed, inline-kode og kodeblokke.

## Test

```bash
npm run check
npm test
npx playwright install chromium
npm run test:browser
```

Integrationstests bruger midlertidige lokale HTTP/WebSocket-servere. Browsertests bruger en isoleret fixture på port 4311, aldrig dine rigtige sessioner. De dækker login, adgangskontrol, sikker tekstvisning, historik, streaming, godkendelser, spørgsmål, styring, stop, kladder, genindlæsning og mobilnavigation. Transporttesten dækker reconnect og sikrer, at handlinger ikke gensendes. Derudover testes sprog- og temaskift, filpanel, Git-status/diff, køens redigering/annullering/steer, afsendelsesfejl og samtidige køhandlinger. Tests kræver tilladelse til lokale sockets og browserprocesser.

Til udvikling kan `npm run dev` genstarte webserveren ved kodeændringer. Browserfiler serveres direkte fra `public/`; genindlæs siden efter ændringer. Genstart af serveren kræver et nyt browser-login. Playwright kan kræve yderligere operativsystempakker for at starte Chromium. Testresultater ligger i ignorerede mapper og skal ikke committes.

## Fejlfinding

| Symptom | Kontrollér |
| --- | --- |
| Rød forbindelsesprik | Kører Codex-daemonen, og peger `CODEX_APP_SERVER_SOCKET` eller `CODEX_APP_SERVER_URL` på den rigtige transport? Se webserverens terminal for fejl. |
| Login afvises | Brug den aktuelle nøgle fra `.remote-codex/access-key`, eller værdien af `REMOTE_CODEX_TOKEN`, hvis den er sat. Efter gentagne fejl kan login være midlertidigt begrænset. |
| Siden kan ikke åbnes fra en anden computer | Brug servermaskinens adresse, kontrollér binding, firewall og netværksrute. `127.0.0.1` henviser til computeren, hvor browseren kører. |
| Host eller Origin afvises | Ved eget domæne skal `REMOTE_CODEX_ORIGIN` matche den præcise browser-origin med protokol og eventuel port, uden afsluttende skråstreg. |
| Sessions vises, men en aktiv tur mangler | Kontrollér, at den lokale klient og webserveren bruger samme app-server. Gemte sessions kan stamme fra andre processer. |
| Køfunktionen er utilgængelig | Den tilsluttede Codex-version eller session understøtter muligvis ikke de eksperimentelle kømetoder. Steer kan stadig bruges på en aktiv tur. |
| Git-fanen viser ingen repository | Sessionens projektmappe skal ligge i et Git-repository, der er tilgængeligt for webserverens bruger. |
| En filændring mangler i Codex-fanen | Fanen viser registrerede, gennemførte `fileChange`-elementer. Brug Git-fanen for den aktuelle arbejdsmappe, og vær opmærksom på markeret afkortning. |
| Porten er optaget | Stop den anden webserver, eller vælg en anden `REMOTE_CODEX_PORT`. |
| Live-opdateringer kommer først forsinket gennem en proxy | Slå buffering fra på `/api/events`, og sørg for, at proxyen tillader langvarige SSE-forbindelser. |

## Projektstatus

Remote Codex er en selvstændig, eksperimentel browserklient. Projektet er ikke et officielt OpenAI-produkt. Der medfølger ingen cloudtjeneste, automatisk publicering, enhedsparring eller systemtjeneste. `package.json` har `private: true`, så pakken ikke ved en fejl publiceres til npm.
