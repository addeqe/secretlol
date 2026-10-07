# Publicering och första verifierade import

Publicerat 7 oktober 2026. Denna fil beskriver den första kontrollerade körningen;
aktuell importstatus finns via det privata API-anropet `/meal/status`.

- API: https://willys-catalog.abowlena.workers.dev
- Databasarkiv: https://github.com/addeqe/secretlol/releases/tag/meal-data-2026-10-07
- Första importjobbet, slutfört utan fel: https://github.com/addeqe/secretlol/actions/runs/37659294707
- API-guide: [mealplanner-api.md](../docs/mealplanner-api.md)
- Manifest: [manifest.json](manifest.json)

Första etappen laddade **3 049 av 15 244 recept** till Cloudflare och krävde
**4 173 skrivna D1-rader**. Hela gemensamma ingrediensinventeringen med 881 namn,
filterdefinitioner, sökindex och källmetadata laddades också. Förväntad storlek för
hela receptdatabasen, provladdad lokalt med samma schema, är cirka 370,5 MB.
Receptens fullständiga ingrediens-, recensions- och filterinnehåll bevaras i
kompakta dokument; normaliserade tabeller finns dessutom kvar i SQLite-arkivet.

Den befintliga Willys-kopplingsuppdateringen använder nu den uppladdade
molninventeringen. Den verifierade körningen innehåller exakt **881 namn**, varav
**874 matched** och **7 non_purchased**, för samlingens 96 082 ingrediensrader.
Ingen koppling från den gamla större listan finns kvar i aktiva/äldre länkversioner.
Alla valda produkter kontrollerades mot den befintliga ingrediens-/köttpolicyn.
Katalog och kopplingar var aktuella vid kontrollen den 7 oktober.

Planerade etapper, vid lyckade schemalagda körningar:

| Etapp | Datum | Recept i etappen | Totalt |
|---|---|---:|---:|
| 1 | 7 oktober, slutförd | 3 049 | 3 049 |
| 2 | 8 oktober | 3 049 | 6 098 |
| 3 | 9 oktober | 3 049 | 9 147 |
| 4 | 10 oktober | 3 049 | 12 196 |
| 5 | 11 oktober | 3 048 | 15 244 |

Workflowen körs 05:30 UTC, alltså 07:30 svensk sommartid dessa datum. GitHub kan
fördröja schemalagda jobb. Kvotbrist eller tjänstefel kan flytta en etapp; en
omkörning återupptar samma etapp och importerar inte nästa etapp samma UTC-dag.
Efter femte verifierade etappen öppnas recept-API:t och importworkflowen stänger
av sig själv. Den vanliga dagliga Willys-uppdateringen fortsätter.

Verifiering före publicering: 64 automatiska tester och test i Cloudflares lokala
körmiljö. Alla fem datafiler provladdades och varje ursprungligt receptfält,
ingrediensrad, recension och receptfilter jämfördes med SQLite-källan. GitHubs
serverkontrollsummor för samtliga sju databas-/importbilagor stämmer med manifestet.
API-autentisering, importstatus och övergången till molnets inventering
kontrollerades också i den riktiga molntjänsten.
