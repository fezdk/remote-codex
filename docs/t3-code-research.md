# T3 Code som reference

Undersøgt 8. september 2026. Projektets fokus er Codex; understøttelse af flere agenttyper er ikke et krav.

## Hvad matcher projektet?

Det relevante produkt ser ud til at være **T3 Code**. Produktet beskriver en fælles brugerflade til lokale coding agents, med blandt andet Codex og Claude Code. Det er en relevant reference til browserbaseret fjernstyring. [Produkt](https://t3.codes/)

Der findes et konkret adapterlag: `ProviderAdapterShape` definerer blandt andet start, beskeder, stop, godkendelser, spørgsmål, historik og agentens understøttede funktioner. `CodexAdapter` oversætter Codex-runtime til denne fælles kontrakt. Det bekræfter idéen om et lag foran forskellige agents. Kontrakten alene dokumenterer ikke tabsfrit skift mellem forskellige agents i en eksisterende samtale. [Adapterkontrakt](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/provider/Services/ProviderAdapter.ts), [Codex-adapter](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/provider/Layers/CodexAdapter.ts)

## Den afgørende forskel: samme levende session

Den undersøgte `CodexSessionRuntime` starter en child process med argumenter til `codex app-server`, forbinder via `layerChildProcess` og har et resume-cursor med Codex-thread-ID. Det viser en runtime, som T3 selv starter og administrerer. Det dokumenterer ikke tilslutning til den allerede kørende Remote Control-daemon, som dette projekt bruger. [Runtime, især opstart omkring linje 1141–1172](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/provider/Layers/CodexSessionRuntime.ts), [Argumenter til opstart](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/provider/Layers/codexLaunchArgs.ts)

Vores integration forbinder til den eksisterende daemon via Unix-socket. At kunne genindlæse gemt historik og at kunne styre præcis den samme aktive tur skal fortsat behandles som to særskilte krav. Vi har ikke installeret T3 eller testet alle dets integrationsveje; konklusionen gælder den inspicerede kode.

## Fjernadgang og enheder

T3 dokumenterer både direkte netværksadgang, SSH, Tailscale HTTPS og T3 Connect. Enhedsparring bruger et engangslink, som giver efterfølgende sessionsadgang; adgang kan tilbagekaldes pr. enhed. Deres hostede webapp kræver et tilgængeligt HTTPS-endpoint. Et pairing-link gør ikke i sig selv en lokal server tilgængelig udefra. T3 Connect er deres separate løsning til at gøre miljøer tilgængelige uden router-portforwarding. [Officiel vejledning om fjernadgang](https://github.com/pingdotgg/t3code/blob/main/docs/user/remote-access.md)

## Vurdering for remote-codex

Behold Codex som eneste agent og den direkte forbindelse til brugerens daemon. Det eksisterende `server/codex.js` er en tilstrækkelig afgrænsning for nu. Et generelt providerregister og et agentvalg i UI'et har ingen konkret opgave endnu.

De mest relevante idéer til kommende arbejde er:

1. Enhedsparring med engangskode eller QR og mulighed for at tilbagekalde den enkelte browsers adgang.
2. En samlet opsætning af fjernadgang, hvor netværksforbindelse og browser-login er tydeligt adskilt.
3. Fortsat test af samtidige klienter, reconnect og samme aktive Codex-tur, så lokal app og browser viser og styrer samme arbejde.

T3 Code er også et muligt færdigt alternativ, hvis behovet senere udvides til flere agents og mere omfattende projektstyring. Før et eventuelt skift skal tilslutning til brugerens eksisterende aktive daemon verificeres konkret. Der er ikke grundlag i denne undersøgelse for at erstatte vores integration alene ud fra ligheder i brugerfladen.

Undersøgelsen ændrer ikke applikationen eller netværksopsætningen. Links til `main` kan ændre indhold over tid.
