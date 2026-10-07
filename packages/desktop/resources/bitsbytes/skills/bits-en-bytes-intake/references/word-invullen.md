# Word invullen in één uitvoering

Gebruik bij het bekende formulier de meegeleverde Python-hulp met `python-docx`. Deze bewaakt de veldindeling, verandert alleen antwoordcellen, laat ontbrekende gegevens leeg en controleert de opgeslagen inhoud. Een aparte inspectie of brede documentworkflow is voor gewone invulling niet nodig.

## Gegevens

Maak een UTF-8 JSON-object met alleen de velden waarvoor je inhoud hebt. Weggelaten sleutels, `null`, lege tekst en een lege afsprakenlijst worden lege antwoordcellen. Een onvolledig antwoord blokkeert de uitvoer niet.

| Sleutel | Veld |
| --- | --- |
| datum | Intake-datum |
| deelnemer_naam | Deelnemernaam |
| deelnemer_adres | Beschikbare adresdelen |
| deelnemer_telefoon | Nummer deelnemer |
| deelnemer_geboortedatum | Geboortedatum |
| deelnemer_geslacht | Opgegeven geslacht |
| deelnemer_bsn | BSN als tekst; leeg bij twijfel |
| contactpersoon_naam | Formele contactpersoon |
| contactpersoon_telefoon | Nummer contactpersoon |
| financiering | Bekende financieringsinformatie |
| achtergrond | Eén of twee alinea's |
| ict_affiniteit | Eén of twee alinea's |
| afspraken | Tekst of lijst van afspraak- en planningspunten |

Gegevens zijn teksten; `afspraken` mag ook een lijst van teksten zijn. Geef nummers niet als JSON-getallen op. Voeg duidelijk gedicteerde cijfergroepen samen zonder cijfers te veranderen. Bij een onduidelijk of niet bruikbaar BSN geef je lege tekst op. De hulp controleert alleen de negen-cijfernotatie; dit bewijst geen identiteit.

## Voorkeursopdracht

Gebruik een beschikbare Python-runtime en vervang werkpaden door de werkelijke paden van deze intake:

```text
python scripts/intake_docx.py create --data "/werk/gegevens.json" --fallback-dir "/uitvoer"
```

Deze ene opdracht opent standaard het vaste netwerktemplate, vult alle velden, bewaart in de vaste intake-map en controleert de opgeslagen bytes. Ontbrekende gegevens blijven leeg. Bij een bestaande naam gebruikt zij `(2)`, `(3)`, enzovoort. Als opslaan in de doelmap niet lukt, schrijft zij naar de opgegeven lokale uitvoermap. Die map kan zo nodig worden aangemaakt.

Gebruik bij een geüpload template ook `--template "/pad/naar/Intakegesprek blanco.docx"`. Een andere `--output-dir` is alleen bedoeld voor een expliciet andere bestemming of een geïsoleerde test. De uitvoer meldt de werkelijk gebruikte bestandslocatie en of de lokale terugval is gebruikt; herhaal daarna geen complete controle.

Naam nog onbekend na de ene vraag? De hulp gebruikt `Intakegesprek deelnemer.docx`, zonder de naam in het formulier te verzinnen.

Bij een gewijzigd template stopt de hulp vóór schrijven. Gebruik dan documenttools voor de actuele indeling. Gebruik een visuele controle alleen bij een concrete reden, zoals een gewijzigde opmaak of tekst die zichtbaar niet past.

## Andere opdrachten

Alleen als je ze echt nodig hebt:

```text
python scripts/intake_docx.py inspect --template "/pad/naar/template.docx"
python scripts/intake_docx.py fill --template "/pad/naar/template.docx" --data "/werk/gegevens.json" --output "/uitvoer/Intakegesprek voornaam achternaam.docx"
```

`inspect` toont labels en locaties zonder persoonsgegevens. `fill` schrijft naar een exact gekozen, nieuw bestand en weigert overschrijven. Bij `create` en `fill` wordt het blanco bronbestand nooit gewijzigd. De hulp transcribeert niet en bepaalt niet welke uitspraken feiten of afspraken zijn; dat gebeurt in de gespreksanalyse.
