# Ny arbetsplan: bygg råvaruregistret före receptimporten

Datum: 2026-10-14. Uppdaterad efter beslutet att använda den kopplade
butiksvarans näringsdeklaration i stället för USDA-matchning. Detta ersätter
arbetssättet med upprepade små aliasrättningar
följda av en ny receptkörning. Det är en genomförandeplan med lokala förprov,
inte ett besked om att den nya motorn eller massimporten är färdig.

## Vad undersökningen faktiskt visar

Det tidigare USDA-flödets urval gav **6 kompletta matrecept av 1 000**. Av de
595 poster som återstod efter halal- och icke-mat-exkludering hade endast
39 produktidentitet för samtliga ingredienser och 42 näringsidentitet för
samtliga ingredienser. Dessa tal är olika delmängder och får inte adderas.

Den lokala USDA-källan innehåller 7 793 livsmedel. Nuvarande huvuduppslagning
har 265 granskade referenser, kompletterade med några entydiga bokstavliga
namn. Det är därför missvisande att beskriva motorn som att den redan kan
koppla valfri ingrediens mot hela USDA. Butikens ordförråd har 415 regler;
även där måste känt livsmedel skiljas från en faktiskt godkänd aktuell vara.

Nuvarande mängdtolkning avbryts dessutom vid osäkert ingrediensnamn. Ett
uttryckligt `1 lb` kan alltså försvinna för att exempelvis namnet på pastan
inte känns igen. Det är ett konstruktionsfel: källmåttet och identiteten är
två separata fakta.

Slutligen innehåller mellanformatet många upprepade parser-, allergen- och
aggregatbelägg. Det senaste 1 000-urvalets `recipes.jsonl` är cirka 123 MiB.
Ett stort JSON-dokument per recept är olämpligt som huvudsakligt arbetslager
för två miljoner recept.

## Genomfört den 14 oktober

Det produktbaserade utvecklingsprovet före dagens registerutökning gav ett
planerarberäkningsbart recept av 1 000. Två poster hade kompletta kalorier,
protein, fett och kolhydrater för hela receptet; den ena var en receptkomponent.
Detta är fortfarande otillräckligt för massimport. Äldre USDA-resultat och
produktbaserade resultat har olika underlag och räknas separat.

Följande har genomförts lokalt:

- Ett kompakt arbetslager i schema v3 lagrar återanvändbara belägg en gång.
  1 000 dokument har verifierats genom exakt återläsning. På samma utvecklingsdata
  minskade prototypens databas från 84,68 till 39,66 MiB. Detta är ingen uppmätt
  storlek för den stora importen eller en konvertering av originaldatabasen.
- Ett valfritt register med 261 lokala råvarureferenser och 889 dokumenterade
  portionsvikter har byggts. Produktetikettens värden behåller företräde.
  Generiska kompletteringar märks med egen källa, version och uppskattningsstatus.
  Ingen USDA-sökning, AI eller nätverkshämtning görs per recept.
- Uttryckliga val i källtexten verifieras även i mängdsteget: det första fullständigt
  angivna alternativet eller den redan valda övre ändpunkten i ett intervall.
  Ursprungstext, val och numeriska belägg finns kvar. Kvalitativa mängder förblir okända.
- Tidigare väntande Coop-namn kan omprövas genom verifierad kanonisk identitet och
  en redan godkänd produkt för samma mat-ID. Detta gav 240 ytterligare
  ingredienskopplingar i utvecklingsurvalet, utan ytterligare kompletta planeringsrecept.
- 23 produktkandidater för vanliga råvaror har kontrollerats i ett aktuellt
  Coop-anrop. Alla 23 hade oförändrad identitet. Efter separat granskning godkändes
  20 produktidentiteter för 13 råvaru-ID:n till ett nytt lokalt testregister.
  Ananasförslaget och parmesan med okänd löpekälla avstår fortfarande.
- Rå grönsaksform har fått ett explicit register för godkända produktetiketter.
  Mjölkens volym-till-gram-uppskattning använder en fysisk referens, medan själva
  näringsvärdena kommer från den valda Coop-varan.
- Det aktuella testregistret har egna dataset-ID:n och är märkt `localOnly`.
  Det kan inte publiceras som den befintliga molninventeringen utan separat integrering.

Utvecklingskörningar, råkällor, granskningsbeslut och kontrollrapporter finns i
`data/recipe-ingestion-quality/architecture-reset/`. Den daterade slutrapporten
ska användas för de sista jämförelsetalen; dellösningar räknas inte som kompletta recept.

## Det nya flödet

```text
Källrecept → separat mängdtolkning → ingrediensidentitet + allergener/halal
                                      │
                         godkänd Willys-/Coop-vara
                              │              │
                        pris/förpackning  exakt produktetikett
                              │              │
                         inköpsmängd      näring per g eller ml
                              └──── receptets verifiering
```

### 1. Inventera och återanvänd unika råvaror

Gör en lätt lokal genomgång av källfälten och bygg ett beroenderegister:
vilka ingredienstyper förekommer, och vilka recept kräver dem? Ingen
produktmatchning, fullständig näringsberäkning eller AI per recept i detta
steg. Originaltext, käll-ID och textposition bevaras.

Två nivåer behövs: identiska råa rader kan återanvända samma parserresultat;
olika mängder av samma korrekt identifierade råvara kan återanvända samma
råvarukoppling. Rader med okänt namn får egna belägg och slås inte ihop till
en enda påhittad ingrediens. Rå/tillagad, färsk/torkad, konserverad/avrunnen,
art, fetthalt och obligatoriska produktattribut måste överleva normalisering.

### 2. Läs mängden utan att först kräva ett känt namn

Ett uttryckligt mått registreras med källbelägg även när råvaran är olöst.
Exempel: `1 lb box mostaccioli` innehåller en känd massa på 453,59237 g;
det betyder inte att mostaccioli redan har närings- eller produktkoppling.

`1 can tomatoes` betyder däremot en burk med okänd storlek. Den får aldrig
låna gramvikten från dagens svenska förpackning. Volymer behåller sin
måttstandard; ml blir inte gram utan livsmedelsspecifik densitet.
Kvalitativa mängder såsom salt efter smak bevaras. Skadade bråk och
motstridiga mängder ska fortfarande kunna nekas.

### 3. Bygg ett gemensamt råvaruregister från befintliga belägg

Starta med godkända butikskopplingar.
Den befintliga aktiva receptdatabasen har 881 ingredienskopplingar, varav
874 matchade och sju vattenposter. 299 kopplingar har agentgranskningsbelägg.
Återanvänd granskningen efter kontroll av aktuell produktidentitet och
halal-policy; återanvänd inte gamla observerade priser som dagens pris.

En råvara får ett stabilt ID. Förekomsten i receptet äger mängd, mått,
beredning och källa. Kopplingar till godkända produkter och deras etikettversioner
är separata, versionsstyrda relationer till samma ID. Produktval väljs inom
råvarans verifierade villkor; lägsta pris får inte ändra råvarans identitet.

Näring hämtas med **kedja + exakt produkt-ID + etikettens innehållshash**.
Receptet behöver därför ingen separat livsmedelsmatchning mot USDA för att
beräkna näring. Exempelvis 150 g av en vara med 20 g protein per 100 g ger
30 g protein. Ml får endast användas direkt när deklarationen gäller ml.
Mjölk i en literförpackning kan faktiskt ha deklaration per 100 g; förpackningen
bevisar inte näringsvärden per 100 ml.

Coops befintliga by-ID-svar har redan näringsfält. Dessa bevaras nu i
`product.nutritionSource` och i lokala checkpoints. Etiketterna följer alltså
med samma anrop som prisuppdateringen. Tidigare normaliserade katalogfiler
saknar dessa fält och behöver kompletteras för berörda godkända produkt-ID:n.
De arkiverade 23 produkterna är ett riktat bekvämlighetsurval, inte ett mått
på täckning i hela sortimentet. Willys nuvarande lokala katalog har inga
näringsdeklarationer; produktdetaljkällan måste verifieras separat.

Dokumenterade hushållsvikter/densiteter kan senare återanvändas för fysisk
omräkning, exempelvis en matsked mjöl till gram. Detta är separat från
näringsidentiteten och får aldrig vara ett krav för redan kända gram/ml.
Rå/tillagad, avrunnen och före/efter beredning måste stämma. Etikettens
värden bevisar inte hur mycket frityrolja eller marinad som faktiskt äts.

Äldre automatiska USDA-mappningar får inte importeras som granskade:
undersökningen hittade exempelvis chokladmjölk kopplad till fryst dessert.
Inga nya kulinariska ersättningar införs genom denna plan.

### 4. Prioritera beslut efter antal recept som de hjälper

Mät både hur många recept som påverkas av en ingrediens och hur många som
bara väntar på just den. Lös gemensamma beroenden först och räkna sedan
bara om de berörda recepten. Tio vanliga råvarubeslut kan vara mer värda
än tusen specialfall; effekten ska framgå av beroenderegistret.

En topplista över olösta namn är en arbetskö, inte ett bevis på att namnen
kan kopplas till någon vara. Källa, mängd, retention och övriga hinder
måste räknas med innan ett recept sägs vara upplåst.

### 5. Separera verifierade förmågor utan att blåsa upp antalet kompletta

Spara separata resultat för källans fullständighet, halal, produktkoppling,
inköpsmängd, kostnad och varje näringsvärde. Okända portioner fortsätter
att vara tillåtna enligt tidigare beslut.

Ett känt proteinvärde ska kunna finnas kvar även om kolesterol saknas.
Men receptet får bara användas för ett näringsmål vars nödvändiga värden
är verifierat beräkningsbara. Okänt blir aldrig noll. Okänd saltmängd
ska exempelvis inte presenteras som känt natrium. Ofullständiga poster
ska redovisas separat från kompletta recept även om de får visas i katalogen.

### 6. Använd ett kompakt, inkrementellt arbetslager

Planerad datamodell:

| Relation | Äger informationen |
| --- | --- |
| `source_recipe` | Originalkälla, titel, instruktioner, versionshash |
| `ingredient_occurrence` | Recept-ID, position, rå text, mängdbelägg, beredning |
| `ingredient_identity` | Stabil identitet och obligatoriska egenskaper |
| `identity_retail_product` | Kedja, SKU, villkor, halal- och granskningsbelägg |
| `product_label_revision` | Rå etikett, normaliserade fält, kedja, SKU, innehållshash |
| `product_label_current` | Senaste giltiga observation per kedja och SKU |
| `nutrition_basis_context` | Belägg för etikettens och receptmängdens livsmedelsform |
| `household_measure` | Livsmedelsspecifik omräkning och källa |
| `recipe_dependency` | Vilka beslut som behöver räknas om vid en ändring |
| `recipe_capability` | Resultat per beräkningsområde och regelversion |
| `processing_issue` | Isolerade tekniska fel med original och steg |

Belägg lagras en gång och refereras med ID. Färdiga recept får ett separat
kompakt exportformat. En prisändring uppdaterar prisinformationen, inte
receptets parserresultat eller etikettens hash. En ändrad etikett eller vald
produkt gör berörda näringsresultat gamla. En regeländring räknar om berörda
beroenden. Saknat fiber eller kolesterol får inte stoppa beräknat protein,
men ett fibermål kräver fullständig fiberinformation.

## Källor och korrekthet

Kaggle-källan behålls. Den lokala uppmätta Food.com-källan används bara
med tydlig versions- och identitetskontroll, eller som en separat märkt
källa. Att byta till den löser inte automatiskt produkt- eller näringskopplingar:
den saknar receptnäring och har äldre arraynotation i vissa instruktioner.
Nya ingrediensmängder får inte blandas med andra instruktioner och kallas
samma verifierade recept.

Halal-regler och tillåtna köttmärken gäller både råvara och vald vara.
Allergenförekomst, produktens spårmärkning och okänd information hålls
åtskilda. Ett negativt ordsökresultat är inget allergenintyg.

## Leveransordning och beslutspunkter

- [x] Granska grundarkitekturen och kvantifiera tidigare låga täckning.
- [x] Identifiera befintliga granskningar som kan återanvändas säkert.
- [x] Bevisa fristående mängdtolkning på befintliga kontrollfall och urval.
- [x] Ta fram återanvändbar profilering av ingrediensberoenden.
- [x] Bevara Coops råa näringsfält utan extra detaljanrop vid prisuppdatering.
- [x] Verifiera etikettcache, normalisering och produktbaserad beräkning tillsammans.
- [x] Komplettera godkända Coop-ID:n och mät verklig fälttäckning: 287 tydliga etiketter av 376 ID:n.
- [x] Bygg ett separat normaliserat arbetslager och ett avgränsat källflöde utan USDA-matchning.
- [x] Testa källflödet på 50 utvecklingsrecept och 50 nya; inga krascher, inga godkända massimportresultat.
- [ ] Verifiera Willys detaljkälla och adapter utan att blanda in apparaters energiklass.
- [x] Bygg ett separat lokalt råvaru-/produktregister och koppla butiksetiketterna till det.
- [x] Inför aktuella produkt-ID-kontroller och återanvändbara granskningar för vanliga råvaror.
- [ ] Koppla arbetslager, gemensamt råvaruregister och etikettberoenden i en komplett inkrementell massmotor.
- [ ] Kör samma utvecklingsurval och redovisa verklig ökning av kompletta recept.
- [ ] Kör därefter ett nytt orört slumpurval på minst 1 000 källrecept.
- [ ] Starta massimport först när verifiering och täckning klarar gränsen.

Första täckningsgränsen är fortfarande minst 50 kompletta matrecept av
1 000 slumpmässiga källrecept. Den är ett minimikrav för att investera i
massimport, inte en garanti om 100 000 unika slutrecept. Dubbletter,
halal-exkludering och källfel redovisas separat. Kraven får inte sänkas
för att göra jämförelsen grön.

Rapportera utvecklingsurval och orörda kontrollurval var för sig. Verifiera
källmängder, kompatibla produktformer, brandpolicy, näringsaritmetik,
negativa matchningsfall och felisolering. Granska även ett urval av
avvisade recept för att hitta felaktiga avslag. Ingen AI-genomgång av två
miljoner recept och inga nätverksanrop per recept krävs av arkitekturen.

Den äldre stora importdatabasen är bevarad. Planen innebär inte att den
omklassificeras som färdig eller att användaren ska starta om den idag.
