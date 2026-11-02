# Sähkötilanne

Dashboard Suomen sähköjärjestelmän päivittäiseen seurantaan: järjestelmän tila ja taajuus, tuotantomix, rajasiirrot, käytettävyysrajoitukset (UMM), spot-hinnat, 48 h ennusteet, reservit ja vertailu samaan päivään kolmena edellisenä vuonna.

## Miten se toimii

Fingridin, porssisahko.netin ja Nord Poolin UMM-rajapinnat eivät salli kutsuja suoraan selaimesta (CORS). Siksi data haetaan palvelinpuolella:

1. GitHub Actions ajaa `scripts/fetch.mjs`:n 15 minuutin välein.
2. Skripti kirjoittaa tiedoston `site/data.json`.
3. Työnkulku julkaisee kansion `site/` GitHub Pagesiin. Sivu lukee `data.json`:n samasta osoitteesta.

Fingridin API-avain on GitHubin salaisuus, eikä se näy sivulla.

## Käyttöönotto

1. Hae ilmainen API-avain: https://data.fingrid.fi/en/instructions (Developer portal → Products → Open Data starter).
2. Luo GitHubiin uusi repositorio ja vie nämä tiedostot sinne. Ilmaisella tilillä Pages vaatii julkisen repon.
3. Settings → Secrets and variables → Actions → New repository secret: nimi `FINGRID_API_KEY`, arvoksi avain.
4. Settings → Pages → Source: **GitHub Actions**.
5. Actions → "Päivitä sähkötilanne" → **Run workflow**. Sivu on tämän jälkeen osoitteessa `https://<käyttäjä>.github.io/<repo>/`.

## Rajat

- Fingrid: 10 000 pyyntöä / vrk ja 1 pyyntö / 2 s. Yksi ajo tekee 3 pyyntöä (+3 kerran päivässä historiaan), eli noin 300 pyyntöä vuorokaudessa.
- GitHubin ajastetut ajot voivat viivästyä ruuhka-aikoina. Sivu näyttää datan iän ja varoittaa, jos data on yli 45 minuuttia vanhaa.
- Spot-hinnat (porssisahko.net) sisältävät alv:n 25,5 %.

## Paikallinen testaus

```
FINGRID_API_KEY=... node scripts/fetch.mjs
npx serve site
```

## Aineistot

| Fingrid ID | Sisältö |
|---|---|
| 192, 193, 194 | tuotanto, kulutus, nettotuonti (3 min) |
| 181, 188, 191, 201, 202 | tuuli, ydin, vesi, kaukolämpö-CHP, teollisuus-CHP |
| 177, 209 | taajuus, järjestelmän tila |
| 265, 266 | päästökerroin, kulutus / tuotanto |
| 87, 89, 180, 187 | siirrot SE1, SE3, Viro, Norja |
| 245, 248, 166, 268 | tuuli-, aurinko- ja kulutusennuste, tuulikapasiteetti |
| 317, 318, 52, 51, 244, 106, 319 | reservi- ja säätöhinnat |
| 124, 74, 75 | historia: kulutus, tuotanto, tuuli |

Käytettävyysrajoitukset: Nord Pool UMM API (`ummapi.nordpoolgroup.com/messages`), alue FI, ydinvoima ja vähintään 100 MW rajoitukset.
