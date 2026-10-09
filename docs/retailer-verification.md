# Lokal verifiering: Coop och ICA

Datum: 8 oktober 2026. Verifieringen använder syntetiska/sparade svar och lokala databaser. Den verifierar inte ett komplett verkligt sortiment, riktiga ingredienskopplingar eller molnkvoter.

| Kontroll | Resultat |
|---|---|
| `npm run check` | Passerar |
| `npm test` | 184 av 184 tester passerar |
| `npm run test:worker` | Passerar med fyra lokala databasbindings; inga fjärrresurser används |
| `npm run retailers:demo` | Passerar; noll butiks- och Cloudflare-anrop |
| `npm run retailers:init` utan molnflaggor | Returnerar lokal installationsplan; noll Cloudflare-anrop |

Tester omfattar datalagring och prisdeltan, komplett respektive avbruten insamling, dubbla kategorier, pagination, återförsök efter avbrutna svar, anropsbudget, checkpoints, aktuella dataset och granskade produktidentiteter. En oförändrad lokal publicering ändrar två metadatarader och skriver inte om produkt- eller prishistorikrader. Faktiska D1-indexkostnader mäts efter installation.

Korgtester täcker delade produkter, blandade förpackningsstorlekar, pant, viktpris, medlems-/mängdvillkor, okända mängder, inkompatibla enheter, avrunnen vikt och tidsgränser. Extra granskning med Luna 6 hittade och rättade två numeriska gränsfall: positiva små mängder får inte försvinna, och förbrukningskostnaden avrundas först efter summering över hela korgen. Regressioner omfattar både små mängder och stora/små kombinationer i olika ordning. Genomförbar korg och bevisat billigaste korg redovisas separat när beräkningsbudgeten tar slut. API:t delar högst 20 000 arbetssteg mellan upp till tre finalister. Verklig CPU-förbrukning på gratisnivån återstår att mäta.

Det sparade lokala receptunderlagets sex komprimerade delar har kontrollerats mot manifestets byteantal och kontrollsummor utan molnanrop. Receptdelarna innehåller 15 244 poster och ingrediensinventeringen 96 082 förekomster av 881 unika namn. Dess hash och dataset stämmer med manifestet respektive den sparade molnstatusen. Detta ersätter inte kontroll av den aktiva molnversionen före nästa publicering.

API-tester kontrollerar att Coop/ICA-sökning filtrerar bort endast berörda recept, att godkända reserver används och att Willys-data inte används för en annan kedjas offert. Gamla Willys-anrop, behörighet, receptfilter, mängdskalning och kostnadsberäkning passerar sina tidigare kontroller. Ingen kundoffert skriver i D1. Delad priscache använder ett gruppdokument i stället för ett anrop per produkt; ett test med 400 priser använder en cachelagring och en kall cacheläsning.

Coops automatiska källa har nu verifierats lokalt med riktiga anrop för pickupbutik `035000`: kategoriträd, tre produktuppslag och två separata sidor med 24 Skafferi-produkter vardera, genom fyra paced anrop utan återförsök. Kategorin rapporterade 1 836 produkter; provet kontrollerade bara dessa två sidor. Parsergranskningen rättade att förpackningspris kunde få jämförprisets kg-/literenhet. Regressionen genom parser och korgberäkning bekräftar att 640 g tortilla och 250 g smör kräver två respektive ett paket, 8 940 öre i inköp och 5 965 öre i förbrukning. Testerna omfattar också offentligt erbjudande, medlems-/mängderbjudande, riktig viktvara, pant, ofullständiga svar och verkliga navigationsposter.

Butikssökningen behåller nu både Coops fysiska pickup-punkts-ID och fulfilment-butikens pris-ID när de skiljer sig åt, till exempel ett skåp som tillhör en annan prisbutik. Offerten använder fulfilment-butikens onlinepris för pickup; den visar inte hyllpriset på den fysiska pickup-platsen.

ICA:s butikssökning och butiksspecifika kategoriträd fungerar från servern. Produktanropen får CloudFront 403 trots korrekt butiksadress och anropsformat. Den normala webbappen visar priser genom sin AWS WAF-integration; någon reproducerbar automatisk produkt-/priskälla för GitHub/Worker har inte verifierats. ICA:s prisadapter hålls avstängd. Se [källunderlaget](upstream-ica.md) och [återstående molnkälla](ica-browser-bridge.md).

Fullständiga scans, massgranskning, nya molndatabaser, importer och driftsättning har inte körts. Dagsjobbet är förberett och avstängt. Coop måste dessutom verifieras i den tänkta körmiljön innan drift.

Coops källobservationer gäller i högst 24 timmar eller till valt erbjudandes slut. Den lokala kundcachen begränsar samma observation till 30 minuter. Regressioner täcker referenspris efter sex timmar, ett erbjudande som slutar efter 20 minuter och lokal cache som löper ut efter 30 minuter.

Ett separat, avgränsat ICA-browserprov i `scripts/probe-ica-browser.mjs` har körts efter användarens uttryckliga godkännande. Vanlig Chromium öppnade butikssidan och följde dess kakdialog/kategorimeny. Den sista produktkontrollen upptäckte CAPTCHA och stoppades utan lösning eller ytterligare liveförsök. Ingen komplett produkt-/prisartefakt skapades. Automatisk ICA-prishämtning förblir avstängd. Syntaxkontrollen passerar och standardkörningen stoppar fortfarande före browserimport och nätåtkomst.
