# Coop och ICA: arbetslista

Senast avstämd: 9 oktober 2026. Planen är godkänd. Den här listan skiljer mellan det som finns förberett lokalt och det som återstår innan butikskällor, molndatabaser eller daglig drift kan användas. En bock betyder att arbetet finns i repot; den betyder inte att en livekälla eller molninstallation har verifierats.

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
- [x] Dagligt workflow finns för enbart Coop och är avstängt tills `COOP_DAILY_ENABLED=true`. Det delar GitHub Actions-skrivkonkurrensgrupp med övrig katalog/import. ICA är uppskjutet.
- [x] Ingen betald AI-runtime eller AI-API behövs i vanlig kunddrift eller daglig uppdatering. Luna-granskning av kopplingar är ett separat manuellt arbetssteg.
- [x] Det sparade, komprimerade releaseunderlaget har verifierats lokalt mot manifestets kontrollsummor och ingredienshash: 15 244 recept, 96 082 ingrediensrader och 881 unika ingrediensnamn. Datasetet överensstämmer med den sparade molnstatusen; den aktiva molnversionen ska fortfarande kontrolleras före publicering.

## Livekällor: verifierat respektive avstängt

- [x] Coop: postnummeruppslag efter pickupbutiker och ett kategoriträd har verifierats. Generiska produktuppgifter används aldrig som bevis för lokalt pris.
- [x] Coop: den riktiga kategori-/browse-endpointen utan sökord, offset-pagination samt produkt-/batchuppslag med butiksspecifika onlinepriser har verifierats genom avgränsade serverprov. Prisadaptern stöder hämtning utan leveranstid. Medlems- och mängderbjudanden väljs inte som allmänt pris.
- [x] ICA: postnummeruppslag och butiksspecifikt kategoriträd fungerar automatiskt. En anonym webbläsarsession visar butiksspecifik kategori, produkt och priser.
- [x] Coop: full startscan av Stora Coop Västberga, butik 256600, pickup: 14 368 unika produkter, 748 lövkategorier, 1 121 sidor. Alla kategoriantal stämmer; 1 294 upprepningar mellan kategorier har slagits ihop. Kategoriträd och källartefakter är sparade med kontrollsummor. Butiken är dokumenterat en Stora Coop; störst i Sverige har inte verifierats.
- [ ] Coop: verifiera källa från GitHub Actions och Worker innan full drift.
- [ ] ICA: automatisk produkt-/prishämtning från backend eller GitHub Actions återstår. Exakta första­parts­anrop från server får CloudFront 403, medan webbappen använder `AwsWafIntegration.fetch`. ICA:s produkt-/prisstöd är avstängt. Se [källunderlaget](upstream-ica.md) och [browseralternativet](ica-browser-bridge.md).
- [ ] För båda: verifiera identifierares portabilitet mellan butiker, prisvillkor, färskhet samt åtkomst från den tänkta körmiljön innan full insamling.

## Återstår innan användning

- [x] Avgränsade källkontroller och uppföljning med Luna 6 är dokumenterade. Coop har automatisk kategori-/produkt-/prishämtning och sparade testsvar. ICA:s automatisk kategoriåtkomst är löst; produktvägen är ännu blockerad från servern. Den 9 oktober har Coops fulla startscan körts, aktuell molninventering lästs och Coop-databasen skapats efter kvotkontroll.
- [x] Utred alternativa officiella ICA-källor efter CAPTCHA-resultatet och förbered [åtkomstplan och oskickad förfrågan](ica-data-access.md). Ingen dokumenterad gratis komplett prisfeed hittades; produktmasterdata och erbjudanden uppfyller inte kravet.
- [ ] Få ICA eller en behörig butik att bekräfta en godkänd produkt-/priskälla, kostnad och tillåten molndrift. Verifiera sedan det faktiska formatet och åtkomst för både referensbutik och kundens lokala butik. Fortsätt inte med berörd full scan om enumeration och prishämtning saknas.
- [x] Kontrollera återställd delad kvot: 33 439 skrivningar uppmätta före installationen den 9 oktober. Coop-import, Willys och receptimporten måste fortfarande rymmas tillsammans.
- [x] Välj stor Coop-referensbutik och genomför budgeterad full scan med kontroller av antal och dubbletter. ICA ligger utanför dagens arbete.
- [ ] Läs den aktuella molninventeringen med 881 unika ingrediensnamn och 15 244 recept. Skapa kandidatbatcher och låt Luna 6 granska/importera kopplingar; validera policy, känsliga beslut, reserver och täckning.
- [x] Skapa separat Coop D1-databas och kör migration. Ingen ICA-databas har skapats.
- [ ] Driftsätt Coop-binding och publicera granskade kopplingar efter förnyad kvotkontroll.
- [x] Typkontroll passerar, hela testsuiten passerar **197/197** och Worker-provet med separata lokala databaser passerar. Även befintliga Willys-anrop ingår. Se [verifieringen](retailer-verification.md).
- [x] Det avgränsade ICA-browserprovet har körts med vanlig Chromium/Playwright efter användarens godkännande. Butikssidan öppnades, men produktkontrollen stoppades av CAPTCHA. Ingen CAPTCHA löstes och inga ytterligare liveförsök gjordes därefter. ICA:s automatiska prishämtning är fortfarande avstängd. Syntax och spärren för standardkörning passerar. Se [provet](ica-browser-probe.md).
- [ ] Granska faktiska små offerter, färskhet, reads/writes, cache och misslyckade/partiella källsvar. Inget fullständigt scan- eller molnjobb räknas som säkert genomförbart enbart för att koden finns.
- [ ] Efter källa, kvot, kopplingar och verifiering: driftsätt och aktivera det dagliga workflowet när arbetet återupptas. Det finns ingen garanti att alla steg kan köras direkt i morgon; luckor i källorna måste först lösas.

### Dagens godkända molnarbete

Användaren har den 9 oktober godkänt Coop-scan, molninstallation och fortsatt driftsättning. Användaren har också godkänt att resterande receptdelar slutförs samma dag om gratiskvoten räcker. Receptimporten kontrollerar kontokvoten före varje del och behåller säkerhetsmarginal. Standardjobbet importerar fortsatt högst en del per dag. ICA:s produktkälla och dagliga drift förblir avstängda.

## Nästa arbetsdag: stopp-/fortsättningsordning

1. Verifiera källorna först. Om Coop browse/pris eller ICA automatisk butikssession fortfarande inte fungerar, dokumentera luckan och stoppa berörd scan/import.
2. Kontrollera kvotåterställning, kontoanvändning och delad läs-/skrivbudget före molnläsning eller skrivning.
3. Kör endast verifierade, budgeterade källkontroller; välj och dokumentera referensbutiker före full scan.
4. Skanna, granska kandidater, importera och skapa DB-bindings/migrationer i små steg med rapportering.
5. Verifiera API- och dagsjobbsbeteende med små fall, inklusive kall/varm cache, CPU och externa anropsgränser på gratisnivån. Driftsätt och aktivera först när källorna fungerar och budgeten räcker.
