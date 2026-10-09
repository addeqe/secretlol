# ICA: återstående molnkälla

Status 8 oktober 2026: underlag för nästa steg, inte en implementerad eller verifierad browserkälla. ICA:s butikssökning och kategoriträd fungerar från vanlig Node-fetch. Produkter och priser fungerar i den anonyma webbappen, men exakta produktanrop från servern får CloudFront 403. Inga Cloudflare-anrop, fulla scans eller deploys har gjorts.

Ett avgränsat prov med vanlig, synlig Chromium via Playwright har nu körts efter användarens uttryckliga godkännande. Butikssidan kunde öppnas och navigeringen rättades för kakdialogen och kategorimenyn. Den sista produktkontrollen upptäckte CAPTCHA och stoppades. Automatisk produkt-/prisåtkomst är därför fortfarande inte verifierad. Ingen ny livekontroll gjordes efter CAPTCHA:n. Se [provresultatet](ica-browser-probe.md).

## Den konkreta skillnaden

ICA:s originalapp använder `window.AwsWafIntegration.fetch` för relativa API-anrop. Appen har också ett CAPTCHA-flöde för svar med status 405 och `x-amzn-waf-action: captcha`. Den vanliga webbläsarsessionen visade produkter utan en synlig CAPTCHA. Att lägga till butikens basePath, korrekt serialization med upprepade tag-parametrar, ordinarie sessionscookies, CSRF och aktuella appheaders har inte gjort serveranropen fungerande.

Butikssidans bootstrap innehåller region-/sessionsmetadata, men tomma produktposter. Den är ingen ersättningskälla. Vi har inte verifierat en produktkälla från GitHub Actions eller Worker och har inte kringgått något skydd.

## Nästa steg: godkänd datakälla

Efter CAPTCHA-resultatet är fler automatiska browserprov inte det rekommenderade nästa steget. Be ICA om godkänd automatiserad läsåtkomst eller en produkt-/prisexport med uttryckliga villkor för molndrift och prisvisning. [Åtkomstplanen](ica-data-access.md) skiljer referensfeed från lokala kundpriser och innehåller en [konkret oskickad förfrågan](ica-data-request.md). En gratis feed eller ett beviljat samarbete är ännu inte bekräftat. Inga skyddsförsök fortsätter och inga meddelanden skickas genom detta dokument.

## Eventuellt framtida browserprov

En browserkälla kan omprövas om ICA bekräftar en godkänd åtkomstväg för denna drift. Då måste en vanlig Chromium-körning i den avsedda molnmiljön först verifieras med 5–10 produkter utan databasimport. Ingen stealth, proxy, tokenförfalskning eller CAPTCHA-lösare används. En begäran om mänsklig kontroll ska stoppa provet.

Det måste bevisa butik, produkt-ID, ordinarie pris, faktisk säljenhet, förpackning, pant och erbjudandevillkor. `Stammispris` och mängderbjudanden får inte bli vanligt styckpris. EAN lämnas okänd om källan saknar den. Webbläsarens cookies, CSRF, WAF-token och kunduppgifter får inte hamna i loggar, artefakter eller vår databas.

Om provet fungerar kan browsersteget ersätta ICA:s direkta HTTP-hämtning för den dagliga, begränsade produktmängden. Verifierade observationer lämnas till befintlig deltapublicering, som skriver bara ändringar. Ingredienspolicy, godkända köttmärken, identitetskontroll och granskade reservprodukter behålls. Partiella eller felaktiga svar får inte ersätta senaste kompletta uppdateringen.

## Lokala kundpriser kräver ett separat beslut

Daglig GitHub-hämtning ger en daterad referensprislista. Den ger inte aktuellt pris från kundens valda lokala ICA-butik vid varje offert. För detta behövs en fungerande källa vid offerttillfället: ett serveranrop som ICA accepterar eller en browser-runtime i molnet med kortlivad, gemensam priscache. En eventuell asynkron offertkö måste ange väntande, komplett, partiell eller utgången status.

Ingen beroende på kundens dator, tillägg eller lokala hårddisk föreslås. Det överensstämmer med appens krav att all drift ska ske i molnet. Det befintliga Worker-API:t kan inte själv starta en Chromium-process. En ytterligare browser-tjänsts gratisgränser och kapacitet behöver verifieras innan vi kan lova gratis kunddrift; detta är inte löst genom att skapa en kö eller ändra en adapterflagga.

ICA:s anonyma UI ber kunden logga in för att se lagerstatus. JSON-LD `InStock`, synligt pris eller förekomst i en kategori bevisar inte vald butiks eller leveranstids lager. Anonyma observationer ska därför ha `availability: "unknown"`. Dagens korgberäkning kräver verifierad tillgänglighet för en komplett offert. Ett separat prisestimat med okänt lager kräver en avsiktlig ändring av detta kontrakt och tydlig märkning; det får inte införas som om lagret redan kontrollerats.

## Klart respektive kvar

- Klart: ICA-butikssökning, butiksspecifikt kategoriträd och identifiering av webbappens riktiga produktanrop.
- Kvar: ett reproducerbart automatiskt browserprov, korrekt produkt-/prisparser och bevis för scope, lager och ID-portabilitet.
- Därefter: mät daglig körning och offertlatens, välj eventuell molnruntime, verifiera gratisgränser samt testa cache och felbeteende.
- Fortfarande spärrat: ICA:s browse/product/prisflaggor, full scan, ingrediensimport och daglig aktivering.

Det här dokumentet ändrar inga API-kontrakt eller aktiveringsflaggor. Coop kan verifieras och byggas vidare separat medan ICA-källan återstår.
