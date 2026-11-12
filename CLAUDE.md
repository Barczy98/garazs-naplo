# Garázs napló

Személyes webapp (PWA) autók nyilvántartására: lejáratok, megújítás, karbantartás, szervizkönyv, tankolás, költségek, titkosított Iratok mappa. Romániai használat (RCA, rovinieta, ITP, impozit auto), a felület magyar nyelvű.

## Két változat, közös kód — MINDIG mindkettőt frissíteni
- iPhone: `Barczy98/garazs-naplo` → https://barczy98.github.io/garazs-naplo/
- Android: `Barczy98/garazs-naplo-android` → https://barczy98.github.io/garazs-naplo-android/

A két repó fájljai azonosak, **egyetlen kivétel a `config.js`** (platform, tárhelynevek). Minden módosítást mindkét repóba fel kell tölteni: a módosított fájlokat át kell másolni a másik repóba, a `config.js`-t soha. Ha a felhasználó kifejezetten csak az egyik változatot kéri, csak azt kell módosítani.

Platformfüggő viselkedés az `ANDROID` (app.js) és `AND` (vault.js) kapcsolóval:
- Naptár: iPhone-on .ics fájl (állandó UID + SEQUENCE, így a régi esemény lecserélődik); Androidon soronként Google Naptár link (Pixel, Xiaomi, legtöbb Android) + .ics letöltés a Samsung Naptárhoz.
- Iratok feloldás szövege: „Face ID” / „ujjlenyomatos feloldás”.
- Szövegekben „iPhone” / „telefon”.

## Kiadás
- Minden kiadásnál növelni kell az `APP_VERSION`-t (app.js) és a `CACHE` verzióját (sw.js), különben a telefon a régi fájlokat mutatja.
- Push után a felhasználónak: 1–2 perc múlva teljesen bezárni az appot és újranyitni internettel.
- Tesztelés: Playwright, iPhone 13 és Pixel 7 emulációval, világos és sötét módban.

## Eddigi döntések (a felhasználó kérése szerint)
- Lejáratok: RCA, rovinieta, ITP, gépjárműadó. CASCO, elsősegélycsomag, tűzoltó készülék NINCS.
- Személyes lejáratok (jogosítvány, személyi, útlevél) autótól függetlenül.
- Karbantartás: olajcsere és vezérműszíj, km vagy idő (amelyik előbb jön). Áttekintésen csak akkor látszik, ha esedékes.
- Tankolás: nincs „tele tank” pipa; a fogyasztás becslés (összes liter / megtett km). „Fedezve” = céges kártya, nem számít a saját költségbe.
- ITP megújítás a mai naptól számol, a többi a régi lejárattól.
- Dizájn: csendes, csoportosított listák; km-kijelző „műszerfal” stílus (nagy vékony számok + olajcsere csík). Hónapkorong NEM kell. Az Iratok mappa dizájnja maradjon.
- Iratok: 4 jegyű PIN + Face ID/ujjlenyomat (WebAuthn PRF), AES-GCM titkosítás. PDF teljes képernyőn, kép kis ablakban, koppintásra teljes képernyő.
- Új dizájn előtt előbb mintát kell mutatni (artifact), és csak jóváhagyás után beépíteni.
