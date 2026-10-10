# Coop och ICA: arbetslista

Senast avstämd: 9 oktober 2026. Coop-referenskatalogen är insamlad, granskade kopplingar publicerade och Coop D1/Worker driftsatta. Daglig Coop-uppdatering är aktiverad och verifierad. ICA är uppskjutet.

## Förberett lokalt

- [x] Godkänd plan för Coop och ICA, inklusive två önskade förbättringar: jämför högst tre menyfinalister med lokala priser före menyval och optimera kostnaden för hela förpackningar över hela inköpskorgen. Se [planen](coop-ica-plan.md).
- [x] Gemensamt `RetailClient`-gränssnitt, Coop- och ICA-adaptrar samt säkerhetsmässigt avstängda funktioner när en källa inte är verifierad.
- [x] Offlinegranskning av kandidatprodukter mot ingrediensinventering och befintlig produkt-/kostpolicy. Granskade beslut kan ha huvudprodukt och kompatibla reserver.
- [x] Separata Coop- och ICA-katalogscheman med butiksscope, spårade produkter, körnings-/aktualitetsmetadata, ändringshistorik, hälsostatus och granskade lokala identitetsmappningar. Receptdata förblir gemensamma.
- [x] Whole-package-optimering som summerar receptens mängder, räknar paket och pant, delar kompatibla paket mellan ingrediensrader och redovisar om bästa resultat verkligen kunde bevisas inom beräkningsgränsen.
- [x] API-förberedelse för butikssökning, kedjestatus och menyoffert med referens- eller lokalpris. Lokalofferten kräver en verifierad butiksscope, godkänd mappning och verifierad prisadapter.
- [x] CLI för syntetisk offline-demo, kapabilitetsvisning, lokal scanartefakt, offlinegranskningsbatcher och uttryckligt gated publicering/uppdatering.
- [x] Insamling har begränsad anropstakt, återförsök vid tillfälliga fel, tids-/anropsbudget, checkpoints för återupptagning och komprimering med kontrollsumma. Detta har testats med sparade eller syntetiska svar.
- [x] Databasinitiering har ett lokalt planläge som standard. Molnvägen kräver separata explicita flaggor och miljövariabel; inga Cloudflare-anrop görs av standardvägen.
- [x] Dagligt Coop-workflow dispatchas av Cloudflare 04:50 UTC när Coop D1-bindingen är ansluten. GitHub-workflowet har ingen egen cron; `COOP_DAILY_ENABLED=true`, skrivbudget 7 000 och delad kvotkontroll gäller fortfarande. Det delar GitHub Actions-skrivkonkurrensgrupp med övrig katalog/import. ICA ingår inte.
- [x] Ingen betald AI-runtime eller AI-API behövs i vanlig kunddrift eller daglig uppdatering. Luna-granskning av kopplingar är ett separat manuellt arbetssteg.
- [x] Det sparade, komprimerade releaseunderlaget har verifierats mot manifestets kontrollsummor och ingredienshash: 15 244 recept, 96 082 ingrediensförekomster och 881 unika ingrediensnamn. Alla fem receptdelar är importerade; `/meal/status` visar `ready: true`. Det tillfälliga meal-upload-workflowet är avstängt.

## Livekällor: verifierat respektive avstängt

- [x] Coop: postnummeruppslag efter pickupbutiker och ett kategoriträd har verifierats. Generiska produktuppgifter används aldrig som bevis för lokalt pris.
- [x] Coop: den riktiga kategori-/browse-endpointen utan sökord, offset-pagination samt produkt-/batchuppslag med butiksspecifika onlinepriser har verifierats genom avgränsade serverprov. Prisadaptern stöder hämtning utan leveranstid. Medlems- och mängderbjudanden väljs inte som allmänt pris.
- [x] ICA: postnummeruppslag och butiksspecifikt kategoriträd fungerar automatiskt. En anonym webbläsarsession visar butiksspecifik kategori, produkt och priser.
- [x] Coop: full startscan av Stora Coop Västberga, butik 256600, pickup: 14 368 unika produkter, 748 lövkategorier, 1 121 sidor. Alla kategoriantal stämmer; 1 294 upprepningar mellan kategorier har slagits ihop. Kategoriträd och källartefakter är sparade med kontrollsummor. Butiken är dokumenterat en Stora Coop; störst i Sverige har inte verifierats.
- [x] Coop: GitHub Actions-källprovet passerade i [körning 37904883640](https://github.com/addeqe/secretlol/actions/runs/37904883640). Coop D1-bindingen är driftsatt och granskad publicering är genomförd.
- [ ] ICA: automatisk produkt-/prishämtning från backend eller GitHub Actions återstår. Exakta första­parts­anrop från server får CloudFront 403, medan webbappen använder `AwsWafIntegration.fetch`. ICA:s produkt-/prisstöd är avstängt. Se [källunderlaget](upstream-ica.md) och [browseralternativet](ica-browser-bridge.md).
- [x] Coop: normal uppdatering passerade i [körning 37908550399](https://github.com/addeqe/secretlol/actions/runs/37908550399): 376 kontrollerade ID:n, noll ändrade produkter, 4 skrivningar och 4 034 läsningar. Cloudflare cron schemalägger dispatch 04:50 UTC varje dag.
- [x] Optimera kalla statusanrop, produktuppslag och upprepade policykontroller. Verifiera referens-/lokalofferter efter driftsättning. Komprimerat offertunderlag, förberedd policycache, snabbare förpackningsoptimering och versionskontrollerad offertcache är införda. Se [verifieringen](retailer-verification.md).
- [x] Driftsätt en liten Worker-gateway och ett separat gratis DO-beräkningslager. Verifiera 18 API-anrop, tre 32-receptfinalister samt 96 olika recept över tre finalister med 200 unika ingrediensnamn. Samma priser och explicita olösta mängder bevaras. Ingen betald plan har aktiverats.
- [x] Verifiera både gatewayens CPU och beräkningslagrets CPU/duration efter att Cloudflares telemetri hunnit läsas in.
- [ ] Fortsatt trafiklastprov när användningen växer. Det avgränsade API-provet bevisar inte obegränsad kapacitet.
- [ ] För båda: verifiera identifierares portabilitet mellan butiker och prisvillkor utöver de redan provade butiksscopena. Ett kontrollerat ID mellan två butiker bevisar inte generell portabilitet.

## Återstår innan användning

- [x] Avgränsade källkontroller och uppföljning med Luna 6 är dokumenterade. Coop har verifierad kategori-/produkt-/prishämtning, GitHub Actions-källprov, publicerad katalog och Worker-binding. ICA:s automatik för kategoriåtkomst fungerar; produktvägen är fortfarande blockerad från servern. Den 9 oktober genomfördes Coops fulla startscan och molnpublicering efter kvotkontroll.
- [x] Utred alternativa officiella ICA-källor efter CAPTCHA-resultatet och förbered [åtkomstplan och oskickad förfrågan](ica-data-access.md). Ingen dokumenterad gratis komplett prisfeed hittades; produktmasterdata och erbjudanden uppfyller inte kravet.
- [ ] Få ICA eller en behörig butik att bekräfta en godkänd produkt-/priskälla, kostnad och tillåten molndrift. Verifiera sedan det faktiska formatet och åtkomst för både referensbutik och kundens lokala butik. Fortsätt inte med berörd full scan om enumeration och prishämtning saknas.
- [x] Kontrollera återställd delad kvot: 33 439 skrivningar uppmätta före installationen den 9 oktober. Coop-import, Willys och receptimporten måste fortfarande rymmas tillsammans.
- [x] Välj stor Coop-referensbutik och genomför budgeterad full scan med kontroller av antal och dubbletter. ICA ligger utanför dagens arbete.
- [x] Läs molninventeringen med 881 unika ingrediensnamn och 15 244 recept. Kandidatgranskning och publicering är klara: 564 matchade, 311 behöver granskning och 6 behöver inte köpas. Kopplingarna täcker 7 230 recept och 82 876 av 96 082 ingrediensförekomster. Coop spårar 376 godkända produkt-ID:n; olösta ingredienser förblir olösta.
- [x] Skapa separat Coop D1-databas och kör migration. Ingen ICA-databas har skapats.
- [x] Driftsätt Coop-binding och publicera granskade kopplingar efter kvotkontroll. D1 och Worker är aktiva.
- [x] Typkontroll passerar, hela testsuiten passerar **250/250** och Worker-provet med separata lokala databaser passerar. Även befintliga Willys-anrop ingår. Se [verifieringen](retailer-verification.md).
- [x] Det avgränsade ICA-browserprovet har körts med vanlig Chromium/Playwright efter användarens godkännande. Butikssidan öppnades, men produktkontrollen stoppades av CAPTCHA. Ingen CAPTCHA löstes och inga ytterligare liveförsök gjordes därefter. ICA:s automatiska prishämtning är fortfarande avstängd. Syntax och spärren för standardkörning passerar. Se [provet](ica-browser-probe.md).
- [x] Verifiera referens- och lokalofferter med Coop-priser, inklusive två menyfinalister. För Västberga och Daglivs gav samma gräddprodukt 2 550 respektive 2 755 öre. Aktualitet, cache och offertstatus har regressionstester.
- [x] Kalla receptanrop använder den atomärt publicerade kopplingsstatusen och läser bara begärda kopplingar och produkter. Ändrad version eller policy stänger för gamla sammanfattningar; tidsgränser räknas om.

### Dagens godkända molnarbete

Användaren har den 9 oktober godkänt Coop-scan, molninstallation och driftsättning samt att resterande receptdelar slutförs om gratiskvoten räcker. Alla fem receptdelar importerades med kvotkontroll och säkerhetsmarginal; `/meal/status` visar `ready: true`, och det tillfälliga meal-upload-workflowet är avstängt. Coop-katalogen och granskade kopplingar är publicerade. Det normala Coop-dagsjobbet är aktiverat och har passerat. ICA:s produktkälla och dagliga drift förblir avstängda.

## Nästa arbetsdag: stopp-/fortsättningsordning

1. Coop-dagsjobbet kontrollerar endast de granskade ID:na; en ny full scan kräver ett separat underhållsbeslut.
2. Före framtida molnskrivning: kontrollera aktuell kontokvot och delad läs-/skrivbudget.
3. Fortsätt endast med avgränsade, verifierade Coop-källkontroller. ICA-produkt/pris saknar fortfarande godkänd automatisk källa och är utanför arbetet.
4. Följ kund-API:ts CPU och korgbeteende vid större menyförslag. Ett litet lyckat prov bevisar inte obegränsad kapacitet.
