# ICA: nästa väg till produkt- och prisdata

Kontrollerat 2026-10-08. Detta är en konkret åtkomstförfrågan och integrationsplan, inte en fungerande eller beviljad ICA-feed. Inga kontakter har tagits, inga Cloudflare-anrop har gjorts och inga nya browserförsök har gjorts efter CAPTCHA:n.

## Beslut som behövs från datakällan

Be ICA:s e-handelsorganisation att hänvisa oss till ansvarig för externa produkt-/prisintegrationer. Fråga om godkänd automatiserad läsåtkomst med avtalad anropstakt, eller en automatisk produkt-/prisexport. Börja med en referensbutik; kravet på aktuella lokala kundpriser måste samtidigt omfatta andra valda butiker. Ett godkännande eller en export från en enda butik löser inte lokala priser för hela ICA.

Den offentliga [kontaktvägen för e-handel](https://www.ica.se/kundservice/kontakt/) är 033-47 47 94. [ICA:s vanliga frågor](https://www.ica.se/kundservice/vanliga-fragor/) anger också handlaonline@ica.se. Det är en väg att be om rätt kontakt, inte ett bevis för att de tillhandahåller externa API:er. Ett färdigt, oskickat [förfrågningsutkast](ica-data-request.md) finns separat.

Gratis åtkomst är ett krav från projektet. Fråga uttryckligen om avgifter för data, vidarevisning och integration innan något avtal eller betalt alternativ väljs. Att en teknisk import går att bygga betyder inte att ICA erbjuder data gratis.

## Vad vi behöver få bekräftat

| Behov | Minsta underlag |
| --- | --- |
| Första katalogen | Komplett sortiment för en namngiven referensbutik, stabila produkt-ID:n, namn, varumärke, EAN/GTIN där det finns, förpackningsstorlek, säljenhet och ingrediensinformation där det finns. |
| Daglig uppdatering | Uppslag för en lista produkt-ID:n, inklusive granskade reservprodukter; tydlig status för utgångna och saknade produkter. Hel export fungerar också om det är det enda alternativet. |
| Vanligt konsumentpris | SEK inklusive moms, faktiskt pris per förpackning/kg/liter, pant separat, erbjudandevillkor och giltighet. Jämförpris får inte ersätta säljenhetens pris. Stammis-/personliga priser får inte behandlas som allmänt tillgängliga. |
| Lokal offert | Samma uppslag för kundens valda butik och inköpskanal, med uttryckligt butiksscope och tidpunkt. Referensbutikens pris är ett estimat för andra butiker. |
| Lager och färskhet | Lagerstatus där källan verkligen kan intyga den, annars uttryckligen okänd. Senast kontrollerat och giltighetstid. |
| Rättigheter och drift | Tillåten automatisk molnhämtning, lagring/cache och prisvisning i matplaneraren; kostnad och anropsgränser. Inga kundkonton eller personliga köpuppgifter behövs. |

## Koppling till det som redan finns

1. Ta emot ett litet godkänt exempel, cirka tio produkter, och källans dokumenterade format. Kontrollera butik, ID, ordinarie pris, erbjudande, säljenhet och förpackning mot deras underlag.
2. Bygg normalisering för just det bekräftade formatet. Den befintliga datamodellen hanterar butik, produkt-ID, förpackning, pris, pant, giltighet och lagerstatus. Den har redan identitets-/halalgranskning och deltapublicering som bara skriver ändringar. En generell ICA CSV-/feedimportör är ännu inte byggd.
3. En periodisk export kan mata referenspriser till befintlig publicering och referensoffert. Publicering kontrollerar att godkända produkt-ID:n finns och att observationerna är aktuella innan den aktiva versionen byts.
4. Aktuella lokala offerter kräver dessutom en klient för den godkända källan som kan läsa just den valda butikens produkter. ICA-klientens prisflaggor förblir avstängda tills detta fungerar. En referensfeed aktiverar inte automatiskt lokal prissättning.
5. Bevara okänt lager som okänt. Dagens kompletta korg kräver verifierad tillgänglighet. Ett separat prisestimat med okänt lager behöver en uttrycklig API-status; det får inte presenteras som en verifierat tillgänglig korg.
6. Verifiera små käll- och API-fall, behörigheter, färskhet och gratisbudget. Full scan, molnimport och aktivering följer först efter att åtkomsten fungerar och Cloudflare-kvoten har återställts.

## Vad undersökningen faktiskt visar

- ICA beskriver att [enskilda handlare bestämmer sortiment och priser, även online](https://www.icagruppen.se/om-ica-gruppen/var-verksamhet/affarsmodell/Prissattning-pa-ica/). En butiksexport är därför ett rimligt förslag att fråga om. Vi har inte hittat en offentlig specifikation eller ett besked att en sådan export erbjuds.
- [ICA:s leverantörsflöden via Validoo/Sygrid](https://www.icagruppen.se/leverantorer/ica-online/) tar emot produktinformation och bilder. De är inte dokumenterade konsumentprisflöden till vår app. [GS1 förklarar](https://gs1.se/support/hur-beraknar-jag-jamforpris/) att artikelinformationen inte innehåller produktens pris.
- Publika erbjudanden är inte ett komplett sortiment med ordinarie priser. En gratis konsumentapp hos en annan prisleverantör bevisar inte gratis maskinåtkomst eller rätt att återpublicera data.
- Tre separata granskningar av offentligt underlag har inte hittat en dokumenterad, kostnadsfri feed som uppfyller alla krav. Det utesluter inte privata samarbeten eller godkänd åtkomst. Det betyder att automatisk ICA-drift fortfarande är en olöst extern åtkomstfråga.

Nästa avgörande underlag är ett svar från ICA eller en behörig butik: vilken källa får användas, vilket format, vilka butiker/kanaler, tillåten uppdateringstakt och kostnad. Ingen CAPTCHA-lösare, sessionsöverföring eller ytterligare skyddsomgång behövs för denna föreslagna väg.
