# Garázs napló

Saját webapp az autók lejáratainak (RCA, rovinieta, ITP, gépjárműadó), az olajcserének és a szervizkönyvnek a követésére. iPhone-on a kezdőképernyőre téve appként működik, internet nélkül is.

- Az adatok csak a telefonon tárolódnak (a kódban nincs személyes adat).
- Emlékeztetők: a lejáratok `.ics` fájlként kerülnek az iPhone Naptárába, riasztással.
- Mentés és visszaállítás JSON fájllal (Beállítások).

Új verzió kiadásakor az `sw.js` fájlban a `CACHE` nevét növelni kell.

## Iratok mappa
Képek és PDF-ek (pl. jogosítvány, biztosítás) titkosítva tárolva (AES-GCM). A mappa 4 jegyű PIN-kóddal (PBKDF2) vagy Face ID-val nyílik; a Face ID egy passkey PRF-kimenetéből származtatott kulccsal működik (iOS 18+). Kilépéskor vagy 2 perc tétlenség után zárol.
