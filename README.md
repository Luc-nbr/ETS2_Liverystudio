# ETS2 Livery Studio

Een Windows-programma (Tauri 2) om skins/paintjobs voor **Euro Truck Simulator 2** direct **in 3D** te ontwerpen en als werkende mod te installeren.

## Wat het doet

- **3D is de hoofdeditor.** Alle gereedschappen werken direct op het model:
  - selecteren, verplaatsen over het oppervlak, schalen en draaien (gizmo met hoekgrepen en draaibol)
  - penseel en gum
  - vormen (rechthoek, ellips, veelhoek, ster) en vrije paden
  - tekst
  - PNG/SVG-afbeeldingen (knop 🖼 of slepen op het model)
  - lijnontwerpen met meerdere kleuren
  - pipet en knooppunten bewerken
- **Naadloos over UV-naden en hoeken.** Ontwerpen worden niet in de textuur getekend maar *geprojecteerd*:
  - **Decals** (vormen, tekst, afbeeldingen, paden) liggen op een projectievlak in 3D. De GPU-baker rendert het model in UV-ruimte en berekent voor elke texel zijn 3D-positie en normaal. Daardoor loopt een logo of tekst door over UV-naden en (afgeronde) hoeken.
  - **3D-lijnontwerpen** zijn een pad van punten óp het oppervlak. Ze worden gebakken als afstandsveld, zodat strepen om hoeken heen lopen. Instelbaar per lijnontwerp: meerdere strepen met eigen kleur en breedte (in mm), tussenruimte, onderbroken lijnen en ronde of rechte uiteinden.
  - **Penseel en gum** werken met bolvormige stempels in 3D. Ook die streken lopen door over naden.
- **Spiegelen links/rechts:**
  - "⇋ Spiegelen L/R" zet nieuwe ontwerpen en penseelstreken tegelijk op beide kanten, via het symmetrievlak van het model.
  - Per decal kies je "leesbaar houden", zodat tekst aan de andere kant niet in spiegelbeeld staat.
- **Lossless:**
  - Vectorlagen (vormen, tekst, SVG, lijnen) blijven parameters. Ze worden pas bij het exporteren opnieuw gerasterd en op volle resolutie in de textuur gebakken (tot 8192²).
  - De DDS-export kan ongecomprimeerd (RGBA8).
- **Kleuren:**
  - HSV-kiezer met hex-veld. Je kunt plakken als `#1e88e5`, `1e88e5`, `#18e`, `rgb(…)` of `30,136,229`.
  - RGB- en HSL-velden, kopieerknop en een pipet die overal op het scherm werkt.
  - Een **gekoppeld palet**: wijzig één paletkleur en alle lagen die hem gebruiken veranderen mee.
  - Kleurharmonieën genereren en een kleur in het hele ontwerp vervangen.
  - Verlopen (lineair/radiaal) met meerdere kleurstops.
- **Lagen:**
  - Zichtbaarheid, vergrendelen, dekking en 16 overvloeimodi.
  - Uitknipmaskers, schaduw/gloed, dupliceren en volgorde aanpassen.
  - Ongedaan maken en opnieuw.
- **2D-hulpweergave** van de UV-textuur, om precies uit te lijnen en te controleren. Daarin zie je:
  - het gebakken resultaat met de UV-draadlijnen van het model
  - een optionele officiële SCS-template als overlay
  - raster en uitlijnen
  
  Je kunt hier ook lagen direct in textuurruimte plaatsen.
- **Leest de spelbestanden:**
  - Vindt de installatie via Steam (register + `libraryfolders.vdf`).
  - Leest de `.scs`-archieven (HashFS v1 én v2, zip) en de `def`-bestanden (SII).
  - Toont welke trucks en trailers, cabines en bestaande paintjobs er zijn.
  - Laadt het 3D-model (`.pmd`/`.pmg`) met de lakbare (`truckpaint`) materialen.
  - Extra truck-mods kun je bovenop het spel koppelen.
- **Exporteert een werkende mod** (`.scs` of map) direct in `Documents\Euro Truck Simulator 2\mod`:
  - `manifest.sii`, beschrijving en Mod Manager-afbeelding
  - `accessory_paint_job_data` met `@include`-instellingen en `suitable_for[]` per cabine
  - `paint_job_mask` als `.tobj` + `.dds` (RGBA8 of BC3, met mipmaps)
  - winkelicoon (`.mat`/`.tobj`/`.dds`)
  
  Per cabine kun je een aparte textuur maken.

Zonder spel geïnstalleerd (of in de browser) kun je ontwerpen op een ingebouwde **demo-cabine**.

## Bediening (3D)

| Actie | Muis / toets |
|---|---|
| Gereedschap gebruiken | linkermuisknop op het model |
| Draaien | rechtermuisknop, of links slepen naast het model / met Alt |
| Schuiven / zoomen | middelste knop / scrollwiel |
| Selecteren, Knooppunten, Camera | V, A, H |
| Penseel, Gum | B, E |
| Rechthoek, Ellips, Veelhoek, Ster | R, O, G, S |
| Pad, Lijnontwerp, Tekst, Pipet | P, L, T, I |
| Pad of lijn afronden | dubbelklik of Enter (Backspace = laatste punt weg, Esc = annuleren) |
| Decal in zijn vlak schuiven (i.p.v. over het oppervlak) | Ctrl + slepen |
| Proportioneel schalen / draaien in stappen van 15° | Shift |
| Ongedaan maken / opnieuw / dupliceren / opslaan | Ctrl+Z / Ctrl+Y / Ctrl+D / Ctrl+S |
| Kleuren wisselen, penseelgrootte | X, [ en ] |

## Ontwikkelen

Vereisten: Node 20+, Rust (stable) en op Windows WebView2 (meestal al aanwezig).

```bash
npm install
```

```bash
npm run tauri dev
```

Windows-installer (NSIS + MSI) bouwen:

```bash
npm run tauri build
```

Alleen de frontend in de browser (demo-cabine, geen spelbestanden):

```bash
npm run dev
```

Tests van de bestandsformaten:

```bash
cargo test -p ets2-core
```

## Structuur

```
src/                  React + TypeScript frontend
  viewport/           3D-editor (three.js), GPU-baker, projectiewiskunde, mesh-opbouw
  editor/             documentmodel, store (undo/redo), 2D-renderer, penseel, import
  components/         panelen: kleur, lagen, eigenschappen, spel, export, 2D-hulpweergave
  lib/api.ts          contract met de Rust-backend (Tauri-commando's)
crates/ets2-core/     Rust: CityHash, HashFS v1/v2, SII, PMD/PMG/MAT, DDS/TOBJ, mod-export, game-detectie
src-tauri/            Tauri 2-app (commando's, configuratie, iconen)
```

## Bekende beperkingen

- Getest met synthetische bestanden, nog niet met echte spelarchieven. Het formaat van HashFS v2, PMG 0x15 en de paintjob-definities volgt de openbare documentatie en tools (TruckLib, Paint Job Packer en de SCS Modding Wiki).
- De originele game-texturen in HashFS v2 zijn GDeflate-gecomprimeerd en worden (nog) niet gelezen. Het model toont daarom alleen je eigen ontwerp.
- Welk UV-kanaal de paintjob-layout bevat verschilt per truck. Kies dit in *Spel & model → UV-kanaal* en controleer het met de UV-lijnen in de 2D-hulpweergave.
- Accessoire-overrides (`simple_paint_job_data`) worden nog niet gegenereerd.
