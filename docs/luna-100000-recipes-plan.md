# Arbetsplan för Luna 6: minst 100 000 nya, verkliga och användbara recept

> **Styrande förtydligande från användaren, 2026-10-10:** Målet är att skapa nya, självständigt formulerade recept med verkliga recept som ankare. Food.com behövs inte och ska inte vara en beroendekälla. Källreceptet ska stödja att rätten/receptidén finns; den nya formulan, mängderna och instruktionerna skrivs självständigt och valideras för sig. Ett ankare kan stödja mer än en ny receptpost om varje formula är matlagningsmässigt substantiell och tydligt skiljer sig från ankaret och andra nya poster. Enbart ny titel, text, portionsskala, små mängd- eller kryddskiften och garnityrändringar räknas inte. **Räkneenheten är därför en verifierad, ny receptformula – inte en aldrig tidigare existerande kanonisk maträtt.** Behåll maträttsfamilj/deduplicering som kvalitetskontroll och gruppering, men avvisa inte en i övrigt ny formula enbart för att den bygger vidare på samma maträttsfamilj. Märk egna tolkningar ärligt som inspirerade eller anpassade; påstå inte traditionell autenticitet eller ett ursprungsland utan särskilt stöd.

Plan framtagen 2026-10-10. Detta dokument är ett överlämningsunderlag, inte en genomförd import. Ingen insamling, agentkörning eller molnpublicering har startats genom att dokumentet skapades.

**Arbetssättet:** Luna-agenterna bygger återanvändbar kod, granskar källor och löser osäkra fall. Programmen behandlar stora receptmängder. Agenterna ska inte skriva eller läsa igenom 100 000 kompletta recept i sina konversationer.

**Målet är 100 000 nya godkända receptformulor.** Befintliga receptformulor räknas inte igen. En ny, egen formula kan bygga vidare på en befintlig maträttsfamilj eller ett återanvänt källankare om den är matlagningsmässigt substantiell, självständigt skriven och klarar alla grindar. Att målet kan uppnås med tillräcklig formelvariation, geografisk inspirationsbalans, tillgängliga produkter och högst två användningsfönster är ännu inte verifierat. Piloten nedan ska mäta detta. Brist får aldrig döljas med kosmetiska variationer, falska ursprungsangivelser eller upprepningar.

1. **Lås vad ett godkänt recept betyder**

   Ett nytt recept får räknas först när samtliga kontroller passerar:

   - Ett verkligt, identifierbart recept eller en dokumenterad maträttsidé används som ankare. Spara källans ID/URL, version eller hämtningstid, kontrollsumma och rättighets-/attributionsstatus. Kontrollera villkoren för det faktiska användningssättet; en dataset-spegel är inte ensam bevis för originalmaterialets villkor. Spara inte källtexten i det nya receptet. Food.com är inte en nödvändig källa.
   - Den nya formulan har självständigt skrivna, fullständiga instruktioner och ingredienser, dokumenterat portionsantal/yield samt användbara förberedelse-/tillagningstider. Ingredienser, mängder och instruktioner måste vara konsekventa.
   - Alla ingredienser har tydlig mängd och enhet med verifieringsbevis. Författarens nya mängder styrks av en dokumenterad provbatch/vägning eller annan verifierad specifik grund; ärvda källmängder används bara om de verkligen behålls och får användas. Alla inköpsmängder kan räknas om till produktens g, ml eller st utan olösta konflikter.
   - Alla inköpsingredienser har godkända produktkopplingar. Minst en och samma kedja, Willys eller Coop, ska kunna täcka hela receptet. Att några ingredienser finns endast hos Willys och andra endast hos Coop räcker inte för den nuvarande planeraren.
   - Recept, instruktioner och valda produkter passerar den befintliga ägarpolicyn för halal, inklusive förbuden mot osäkra animaliska källor och osäkra extrakt.
   - Komplett och spårbart näringsunderlag per portion: kcal, protein, kolhydrater, fett, mättat fett, fiber, socker, natrium och kolesterol, enligt nuvarande fält och enheter. Okända värden får inte ersättas med noll.
   - Ingrediens- och receptfilter finns i nuvarande format. Allergi/kost använder `yes`, `no`, `unknown`; osäkra bedömningar blir inte positiva löften.
   - Belagt källankare, land/kök eller uttryckligen märkt inspiration, region, måltidstyp och smakklassificering. En egen formula får inte beskrivas som traditionell/autentisk eller ges ett ursprungsland utan särskilt stöd.
   - Ingen dubblett av receptformulan i den nya samlingen eller mot den befintliga samlingen. Maträttsfamilj registreras för sökning och semantisk granskning, men är inte ensam skäl att slå ihop två substantiellt olika, egna formulor.

   Bilder, recensioner och betyg sparas när de finns och får användas. Saknas de ska fälten vara tomma/null enligt kontraktet, inte fabricerade. Samma sak gäller författaruppgifter. Detta skiljer verkligt saknade metadata från obligatoriska uppgifter för tillagning, kostnad och planering.

2. **Utgå från befintlig kod och data**

   Kontrollerad utgångspunkt: 15 244 befintliga recept, 96 082 ingrediensrader och 881 distinkta ingrediensnamn. Det äldre råmaterialet omfattar 522 517 recept; det historiska urvalet med enheter omfattade 397 353. De historiska antalen innebär inte att dessa recept klarar dagens kvalitets-, kopplings- eller unikhetskrav.

   Läs endast relevanta kontrakt och moduler:

   - Aktiv lokal databas enligt den senaste kontrollerade klassificeringskörningen (2026-10-10): `/home/adde/Music/food_unit_reconstruction/data/outputs/recipes_with_filters_20261010/recipes_with_filters.sqlite`. Den har samma produktobservationer som 2026-10-07-snapshoten; körningsdatumet är nyare men butikspriserna är inte nyhämtade.
   - Råmaterial: `/home/adde/Music/recipes.parquet` och redan hämtade källreferenser under `/home/adde/Music/food_unit_reconstruction/data/`. Inventera vad som faktiskt finns; återhämta inte allt från nätet.
   - Rekonstruktion och klassificering: `/home/adde/Music/food_unit_reconstruction/src/food_unit_reconstruction/`.
   - Policy: `/home/adde/Music/willys-catalog/src/dietary-policy.ts`.
   - Coop-produktkontroller: `/home/adde/Music/willys-catalog/src/retailers/identity.ts`.
   - Export/import: `/home/adde/Music/willys-catalog/scripts/export-meal-data.py` och `/home/adde/Music/willys-catalog/src/meal-import.ts`.
   - API/planeringskontrakt: `/home/adde/Music/willys-catalog/docs/mealplanner-api.md` och `/home/adde/Music/willys-catalog/docs/recipe-planning-profiles.md`.

   Läs original och aktiv databas skrivskyddat. Bygg separat staging. Tidigare bortvalda recept får återprövas från arkiv, men måste passera alla aktuella kontroller; de får inte återinföras enbart för att de finns kvar i ett råmaterial.

3. **Första körningen är en pilot, inte en massproduktion**

   Skapa ett versionssatt körmanifest med källa, policy, katalogversioner, landlista, måltal, programversion och slumpfrö för stickprov. Hämta befintliga godkända kopplingar och nödvändiga katalogdata en gång, behåll dem lokalt under bearbetningen. Använd hemligheter från befintlig miljö; skriv aldrig token i underlag, Git eller agentmeddelanden.

   Inventera källornas täckning och kör cirka 2 000 kandidater, fördelade över de föreslagna länderna och fem måltidstyperna. Granska minst 100 av pilotrecepten oberoende och alla upptäckta riskfall.

   Rapportera, totalt och per land/måltidstyp: tillgängliga kandidater, godkända efter varje kontroll, uppskattad unikhetsgrad, nya ingredienser, granskningsbehov, genomströmning, lagringsstorlek och faktisk förbrukning av agentbudgeten. Ett högt globalt godkännande ersätter inte täckning för ett underrepresenterat land.

   Planera insamlingsvolym med `behövda kandidater ≈ återstående godkända / uppmätt godkännandeandel efter deduplicering`. Exempel: 25 % ger ungefär 400 000 kandidater för 100 000 godkända. Det är ett räkneexempel, inte en uppmätt prognos.

   Om det saknas användbara, spårbara ankare eller underlag för tillräckligt många substantiellt olika receptformulor ska samordnaren redovisa den konkreta bristen och fortsätta med möjlig bearbetning inom budgeten. Antalsmålet får inte betraktas som uppfyllt genom kosmetiska variationer eller sänkta krav.

4. **Välj recept via ingredienserna före dyr bearbetning**

   Bygg en delad ingrediensordlista från redan granskade Willys-kopplingar först. Lägg därefter till godkända Coop-kopplingar. Återanvänd ett beslut för varje återkommande ingrediensidentitet; gör inte samma matchning i varje recept.

   Identiteten måste bevara det som påverkar tillagning, mängd, allergener och produktval: exempelvis färsk/torkad, rå/tillagad, avrunnen, saltad/osaltad och nödvändigt fettinnehåll. Översättningar och synonymer får återanvändas först när betydelsen är verifierad. Originaltexten sparas separat.

   Kör billig förfiltrering i denna ordning: uppenbart förbjudet eller icke-mat → redan kända dubbletter → komplett ingredienslista → befintliga godkända kopplingar → mängd/omräkning → näring → klassificering och slutgranskning.

   Prioritera recept vars samtliga ingredienser redan kan lösas. För nya ingredienser: kontrollera först befintliga Willys-produkter, därefter befintliga Coop-produkter. Ingen ny butiksscan behövs för varje recept.

   Nya tvetydiga ingredienser samlas i en gemensam kö med kandidatprodukter och bevis. Prioritera beslut som låser upp flest unika recept i underfyllda kategorier. Olöst ingrediens innebär att receptet inte räknas, tills problemet faktiskt är löst. Ta inte bort ingrediensen och välj inte en ungefärligt liknande produkt för att få receptet godkänt.

   Spara produkt-ID, kedja, butik/kanal, förpackningsgrund, matchningsbevis och policyversion. Spara godkännande separat för Willys och Coop, så att appen kan välja recept som är kompletta i den valda kedjan. Vatten och andra uttryckligen godkända poster som inte behöver köpas behåller den statusen.

5. **Återanvänd hela halal-policyn**

   Använd den aktuella policyn från koden; skapa ingen förenklad alternativlista i agentprompterna. Vid planens tillkomst är versionen `owner-halal-brands-strict-2`.

   - Kyckling: Eldorado, Affco, Qibbla Halal, Agadeer, Aladin och Jack Link's.
   - Rött/övrigt kött: Affco, Qibbla Halal, Agadeer, Aladin och Jack Link's.
   - Explicit fläsk, alkohol, blod samt policyblockerade osäkra animaliska källor och extrakt utesluts.

   Kontrollera även sammansatta ingredienser, produkternas redovisade innehåll och tillagningsinstruktioner. Ett neutralt ingrediensnamn räcker inte om källan exempelvis anger stekning i fläskfett. Osäkerhet som omfattas av ägarens förbud ska blockera godkännande.

   Byt inte själv vin mot buljong eller fläsk mot kyckling. Välj i stället ett dokumenterat, redan existerande recept utan de förbjudna ingredienserna. Brandreglerna är ägarens urvalspolicy och ska inte beskrivas som en oberoende halalcertifiering.

6. **Mängder och näring ska komma från bevis**

   Återanvänd källstödd mängdparser, bråktal, måttenheter och verifierade densiteter/styckvikter. Spara både originaluttryck och normaliserad mängd med omräkningsbevis. Skilj exempelvis amerikansk cup från metriska mått.

   En känd enhet räcker inte: `1 burk`, `ett paket` eller `1 lök` måste ha dokumenterad användbar förpacknings-/styckgrund om offerten kräver g/ml. Volym till vikt kräver stöd för rätt ingrediens och beredningsform. Befintliga infererade enheter får inte automatiskt räknas som verifierade i den nya samlingen.

   `Efter smak`, okänd mängd, intervall utan bestämd beräkningsgrund och motstridiga mängder bevaras i staging. Hitta dokumenterat stöd eller välj annat recept. Hitta inte på gram för att fylla obligatoriska fält.

   Näring prioriteras från dokumenterade källvärden med känd portionsgrund. Befintlig källnäring per portion får inte delas med portionsantalet en gång till. Om näring beräknas från ingredienser ska det ske deterministiskt med verifierade livsmedelsreferenser, rätt rå/tillagad form och relevanta utbytesfaktorer; resultatet märks som beräknat med referensversion. Saknas stöd för hela receptet blir det inte planeringsklart.

   Kontrollera negativa/orimliga värden, enhetsfel, makronas energirimlighet och portionsgrund. Avvikande recept granskas; värden ändras inte bara för att passa en kontroll. Luna får inte uppskatta näringssiffror ur minnet.

7. **Unikhet gäller den nya formulan; maträttsfamiljen är granskningskontext**

   Upprätta ett gemensamt register med `formula_id`, ankarlänkar och maträttsfamilj innan agenterna godkänner poster. Samordnaren ensam slutregistrerar. Bevara befintliga recept-ID:n och använd ett stabilt ID-register som ger nya formulor globala, API-kompatibla heltals-ID:n; spara även källornas ursprungliga ID/namnrymd. Ett källankare får länkas till flera nya formulor.

   En formula räknas som ny när den självständigt författats, har en matlagningsmässigt meningsfull skillnad mot sitt ankare och befintliga formler, och har en egen fullständig och validerad ingredienslista, mängdgrund och metod. Ändra inte bara titel, formulering, portionstal, förpackningsmärke, liten mängd, enstaka krydda eller garnering. En meningsfull skillnad ska beröra en central råvaras roll, bas/sås, maträttens form eller grundläggande tillagningsmetod och motiveras i en kort granskningsanteckning. När gränsen är osäker blir posten `hold`; den räknas inte.

   Deduplicera i tre steg:

   - Exakta formula-hashar och normaliserade instruktioner fångar identiska eller endast omskrivna formler. Samma käll-ID/URL är tillåtet för flera författade formulor, men källankaret får inte kopieras in som en ny post.
   - Jämför canonical ingrediensidentiteter, deras roller och portionsnormaliserade mängdförhållanden tillsammans med metodsteg och maträttsform. Detta hittar skalade recept, språkvarianter och små ändringar.
   - Gruppera nära relaterade formulor i maträttsfamiljer och låt en oberoende granskare avgöra om skillnaden är tillräcklig. Familjeträffen blockerar inte automatiskt en ny formula; den skapar granskningskrav. En formula kan bara räknas en gång och får inte dubbletträknas mot aktiv samling eller staging.

   Använd hashning och begränsad kandidatsökning för likhet, inte jämförelse av alla recept mot alla. Alla uppgiftsdelar kontrollerar samma formelregister mot både nya och befintliga poster. Automatik och stickprov bevisar inte att semantisk deduplicering är ofelbar.

8. **Fördela utan att förfalska ursprung eller måltid**

   Lås en namngiven landlista i pilotmanifestet utifrån dokumenterad täckning och önskad geografisk bredd. Börja med ett förslag på 30–40 länder från Norden, övriga Europa, Mellanöstern, Afrika, Syd-/Öst-/Sydostasien och Amerika. Redovisa svaga eller saknade länder uttryckligen; välj inte bara bort dem efteråt för att få siffrorna jämna.

   Förslag till mätbar betydelse av relativt jämnt:

   | Fördelning | Mål för 100 000 nya recept |
   | --- | --- |
   | Frukost | cirka 20 000; godkänt intervall 18 000–22 000 |
   | Lunch | cirka 20 000; godkänt intervall 18 000–22 000 |
   | Middag | cirka 20 000; godkänt intervall 18 000–22 000 |
   | Snacks | cirka 20 000; godkänt intervall 18 000–22 000 |
   | Efterrätter | cirka 20 000; godkänt intervall 18 000–22 000 |
   | Varje land i den låsta listan | måltal `100 000 / antal länder`, tolerans ±20 % |

   Detta är föreslagna acceptansgränser. Piloten ska visa om de är möjliga med de övriga kraven; hittills är ingen sådan täckning verifierad. Kräv inte samma femdelning inom varje land, eftersom användaren efterfrågar balans i samlingen, inte en konstgjord likadan mattradition överallt.

   Varje recept får en måltidstyp med käll- eller formelstöd. Ett självständigt författat recept får ett land/kök som *inspiration* när ankarkällan faktiskt styrker den kopplingen; det etiketteras inte som en traditionell rätt eller som receptets ursprung utan separat belägg. Övriga belagda etiketter finns kvar för sökning. Samma ankare får stödja flera receptformulor, men varje formula räknas endast under de inspirations-/måltidsetiketter som den faktiskt har stöd för. Recept med enbart regionstöd får inte räknas som ett specifikt land.

   Välj sluturval med ett deterministiskt program som tar hänsyn till både lands- och måltidsmål, därefter kvalitet och komplett butikstäckning. Styr fortsatt insamling mot faktiska underskott. Såser, rent ris, kryddblandningar och andra komponenter blir inte lunch/middag bara för att fylla antalet huvudrätter.

9. **Delegera i små arbetslag och återanvänd besluten**

   Använd GPT-6 Luna (`gpt-6-luna`) i Standard-läge. Börja med en samordnare och tre arbetande agenter; den här miljön har fyra samtidiga platser inklusive samordnaren. Skapa inte ett stort antal väntande agenter. Återanvänd agenter när deras avgränsade uppgifter är klara.

   | Roll, första omgången | Leverans |
   | --- | --- |
   | Samordnare | Manifest, måltal, globalt register, integration, budget och enda slutskrivaren |
   | Luna A: källor/import | Källinventering, rättighetsmetadata, återupptagbar import och schemaadapter |
   | Luna B: ingredienser | Delad ordlista, Willys först/Coop sedan, mängdstöd, halal- och produktkontroller |
   | Luna C: kvalitet | Näring, klassificering, deduplicering, balanskontroller och oberoende pilotgranskning |

   I nästa omgång arbetar A med källor för de största underskotten, B med nya ingredienser som låser upp flest recept och C med granskning. Flytta oberoende granskning till en annan agent när C själv har gjort bedömningen. Samordnaren kör massbearbetning och integrerar godkända beslut.

   Agenterna ska få korta fristående uppdrag (`fork_turns: none`), gemensamma kontrakt som filreferenser och enbart nödvändiga exempel. Ange modellen uttryckligen vid spawn. Använd normal resonemangsnivå för beslutsarbete, högre endast för konkreta svåra fall.

   Kodägarskap ska vara avgränsat. Varje agent skriver egna förslag/underlag i separata filer. En skrivare integrerar till staging; flera agenter ska inte konkurrera om samma SQLite-fil eller redigera samma importmodul.

   Granska osäkra fall i omgångar om ungefär 20–40 identiteter/kluster. Svaret ska innehålla ID, beslut, bevisreferens och kort orsak. Full recepttext skickas endast när beslutet kräver det. En andra agent granskar nya produkt-/halalbeslut och riskfyllda omräkningar innan de återanvänds brett. Högst två granskningsvarv per svår fråga inom budgeten; därefter karantän och annat recept.

10. **Håll agentförbrukning skild från programmets arbete**

   Import, normalisering, exakta matchningar, beprövade klassificeringsregler, näringsberäkning, hashning, urval och export ska köras som vanlig kod utan modell-anrop per recept. Resultat sparas till filer, inte genom att modellen skriver ut hela datamängder.

   Som storleksjämförelse: att skriva bara 500 token per recept skulle ge 50 miljoner output-token för 100 000 recept. Det är inte rätt väg för den här budgeten. En programkopia eller verifierad deterministisk omräkning kräver inga modell-token för varje överförd ingrediensrad.

   Läs aktuell återstående användning och återställningstid vid start och milstolpar. Budgeten är gemensam för samordnare och agenter. Reservera cirka 20 % av tillgängligt utrymme för integration och granskning. Logga förbrukning i piloten och justera mängden modellarbete efter mätningen; anta inte en fast tokenmängd för ett femtimmarsfönster. OpenAI Docs anger att förbrukningen beror på modell, kontext, verktyg och uppgift; ett användningsfönster garanterar ingen bestämd mängd arbete. [Officiella användningsgränser](https://learn.chatgpt.com/docs/pricing).

   Sikta på att få automatiken och första masskörningen klara under första användningsfönstret. Använd ett andra fönster vid behov för underskott och verifiering. Detta är en målsättning, ingen garanti. Ingen betald API-nyckel, extra kreditköp eller större modell ska användas som dold reservlösning.

   Spara checkpoints efter varje källfil och mindre receptbatch. En omkörning ska använda kontrollsummor och tidigare beslut, inte börja om. Status till samordnaren innehåller antal, felorsaker, nya filer och nästa blockerande fråga; inga långa arbetsdagböcker.

11. **Verifiera före målräkning och publicering**

   Alla kandidater genomgår automatiska kontroller för schema, referenser, mängder, omräkning, källgrund, portionsgrund, obligatorisk näring, policy, produktkopplingar och dubblettregister. Otillgängliga eller ändrade produktidentiteter stoppar godkännande. Slutkontrollen använder aktuella katalog-/kopplingsversioner och den befintliga veckobaserade färskhetsregeln.

   Granska minst 1 000 slutrecept mot källunderlaget, inklusive pilotrecept som fortfarande ingår. Kombinera ett reproducerbart slumpurval med överrepresentation av små länder, sammansatta produkter, animaliska ingredienser, nya alias, mängdomräkningar och misstänkta dubbletter. Detta är stickprovsgranskning, inte individuell granskning av alla 100 000 recept.

   Releasekrav: inga upptäckta kritiska fel i det avslutande stickprovet. Kritiska fel omfattar förbjuden ingrediens, fel produktidentitet, tillagningsavgörande mängdfel, falsk portions-/näringsgrund och upprepningar som räknats som nya rätter. Ett fel ska utlösa rättning och omkontroll av hela den berörda regeln/källgruppen, följt av ett nytt oberoende stickprov där. Noll upptäckta fel är inte ett bevis för 100 % korrekthet.

   Kör dessutom API- och planeringskontroller som verifierar glutenuteslutning, vegetariskt/veganskt, Mellanöstern och specifika länder, alla fem måltidstyper, kostnad per kedja, produktbyten, portionsskalning och de befintliga portionstaken. Näringsmål ska verifieras i slutlig plan; ett proteinrikt recept bevisar inte att en veckoplan klarar alla mål.

12. **Förbered en större databas utan att förstöra gratiskvoterna**

   Behåll samma logiska recept-, ingrediens-, filter-, evidens- och API-kontrakt. Lägg till provenance, stabila globala formel-ID:n, ankarlänkar och maträttsfamiljeregister via en uttrycklig versionsändring. Migrera inte bort befintliga ID:n, användarplaner eller förrådskopplingar.

   Den nuvarande molnlagringen använder `meal_recipes`, `meal_ingredients`, `meal_filter_sets`, offertprojektioner och versionssatta berikningsblock. Den befintliga exporten/importen är låst till fem delar och små skrivuppskattningar samt vägrar skriva över en annan datasetversion. Den kan inte användas oförändrad för den här utökningen. Bygg ett nytt versionssatt manifest med valfritt antal begränsade delar och återupptagning; bevara den gamla releasen.

   Mät hela lagringen på pilotunderlaget: recept, källdata, filterbevis, offertprojektioner, berikning och index. Planera flera D1-databaser om det krävs, med ett litet gemensamt sök-/routingindex och styrning till rätt receptdatabas. Kalla inte en uppdelning inom samma databas för en lösning på storleksgränsen. Använd inte full genomsökning av alla receptdatabaser vid varje appanrop.

   Cloudflare Free har enligt dokumentationen 500 MB per D1-databas, 10 D1-databaser och totalt 5 GB lagring per konto, 100 000 skrivna rader och 5 miljoner lästa rader per dag. [D1-gränser](https://developers.cloudflare.com/d1/platform/limits/), [D1-förbrukning](https://developers.cloudflare.com/d1/platform/pricing/). Kontrollera faktiskt antal databaser och ledigt utrymme, även för Willys, Coop och andra projekt. Håll minst 15 % planerad storleksmarginal och avbryt publicering om allt inte ryms. Gratis lagring för 100 000 nya recept är ännu inte verifierad.

   Nuvarande grundarkiv innehåller cirka 308,5 MB receptdokument för 15 244 recept, före övrig molnlagring. Linjärt motsvarar det cirka 2,0 GB dokument för 100 000 recept. Det är en grov jämförelse, inte en storleksprognos; bland annat recensioner och bevismängd varierar.

   Befintlig import skriver minst recept och offertprojektion per recept. 100 000 nya recept innebär därför minst 200 000 skrivningar före ytterligare metadata, index och berikning. Molnimporten måste kunna fortsätta över flera dagar utan aktivt modellarbete. Högst två agentfönster innebär inte att molnpubliceringen måste eller kan bli färdig inom tio timmar.

   Återanvänd kvotkontroller och delad körkö med kataloguppdateringarna. Räkna även index, migrationer och raderingar. Sätt konservativ dagsbudget efter aktuell kontoanvändning och reservera för prisjobb och app. Alla nya uppslag ska vara indexerade och begränsade; prisuppdateringar ska fortsätta skriva endast ändringar. Klassificera inte om 100 000 recept vid daglig prisuppdatering.

   Räkna om den gemensamma ingrediensinventeringen och dess hash. Kopplingssystemet för både Willys och Coop ska läsa den nya godkända inventeringen från molnet när releasen aktiveras. Produktkopplingar granskas per ingrediensidentitet och uppdateras med befintliga policy-/identitetskontroller. Om fler Coop-ID:n behöver följas ska de läggas till i den spårade mängden med samma deltalogik och ny kvotprognos. Haram eller oanvända kandidater får inte bli aktiva uppdateringskrav.

   Kontrollera även aktuella storleksgränser i policycache och andra antaganden om bara 881 namn. Förbättra dem vid behov med mätningar; en större ingrediensinventering får inte återinföra tidigare CPU-problem.

   Aktivera först när alla receptdelar, filter, ingrediensinventering och båda kedjornas kopplingsmetadata är konsistenta. Använd gemensam versionsstyrning för dataset, profil, policy, inventering och katalogkopplingar, med återgång till föregående fungerande release. Delvis uppladdade data ska inte bli appens aktiva samling. Appens priser fortsätter hämtas via aktuella produkt-ID:n, inte via inbakade receptpriser.

13. **Leveranser och checklista till samordnaren**

   - [ ] Pilotrapport med mätbar täckning, unikhet, agentförbrukning och lagringsprognos.
   - [ ] Versionssatt landlista, måltal och källa-/produktmanifest.
   - [ ] Återupptagbar pipeline med delad ingrediensordlista och granskningsbeslut.
   - [ ] Globalt formelregister som förhindrar upprepningar av recept och flaggar närliggande maträttsfamiljer för granskning.
   - [ ] Separat komplett databas med minst 100 000 nya godkända receptformulor, om målkraven faktiskt kunnat uppfyllas.
   - [ ] Fullständiga klassificeringar, näring, mängd-/enhetsbevis och godkända kopplingar per kedja.
   - [ ] Fördelningsrapport: en rad per land, måltidstyp, butikstäckning och avvisningsorsak. Redovisa också tabellen land × måltidstyp utan att dubbelt räkna recept.
   - [ ] Automatiska integritetskontroller och oberoende slutgranskning med felrapport.
   - [ ] Verifierade API-/planeringskontroller och resursmätning vid den större datamängden.
   - [ ] Importmanifest, molnlagringsplan, kvotstyrd import, aktiverings- och återgångsplan.
   - [ ] Om något mål inte nås: exakt godkänt antal, underskott per kategori, orsak och sparad återupptagningspunkt. Arbetet får inte rapporteras som färdigt enbart för att agentbudgeten tagit slut.

   Föreslagen arbetsmapp för framtida körning: `/home/adde/Music/food_unit_reconstruction/data/outputs/recipe_expansion_100k/`. Spara där manifest, framsteg, staging-databas, ingrediensordlista, granskningsbeslut, avvisningsorsaker, balansrapport, granskningsrapport och releaseunderlag. Skapa inte en separat kopia av hela råmaterialet för varje agent.

**Startuppdrag till Luna-samordnaren:** Läs denna plan och följ aktuella instruktioner för arbetsytan. Kontrollera nuvarande data, tillgänglig användningsbudget och kontrakt. Delegera avgränsade uppgifter till GPT-6 Luna enligt punkt 9 och börja med piloten. Sikta på minst 100 000 nya, verkliga och distinkta receptformulor med verkliga källankare enligt hela planen, med högst två användningsfönster för agentarbetet. Låt program göra massbearbetningen och agenter granska undantag. Håll osäkra poster utanför målantalet. Mät möjligheten att nå antalet, inspirations-/måltidsbalansen och gratis molnlagring innan du påstår att målet går att uppfylla. Börja med lokal staging; publicera inte och ändra inte aktiv produktion förrän användaren har beställt genomförandet inklusive publicering.

Officiella referenser i planen kontrollerades när dokumentet skapades. Kontrollera gällande gränser igen vid genomförandet.
