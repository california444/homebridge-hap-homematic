# CCU-Mock

Ein Node-Skript, das sich für homebridge-hap-homematic wie eine CCU verhält: BidCos-RF, HmIP-RF und VirtualDevices per XML-RPC, Events an angemeldete Clients und eine Weboberfläche. Damit lassen sich Gerätetypen testen, die nicht im Haus sind (Thermostate, Heizungsgruppen …), dazu Fehlerfälle und CCU-Neustarts, ohne die echte CCU zu berühren.

Kein Produktivcode. Der Ordner liegt im Repo, landet aber nicht im npm-Paket.

## Start

```bash
npm run build                      # der Mock liest die unterstützten Kanaltypen aus dist/
node tools/ccu-mock/ccu-mock.mjs   # [--rf 2001] [--ip 2010] [--groups 9292] [--ui 8080] [--host 0.0.0.0] [--state <Datei>]
```

Weboberfläche: <http://127.0.0.1:8080/> (nur lokal erreichbar). Die XML-RPC-Ports lauschen auf `0.0.0.0`.

| Interface      | Port | Pfad                                          | PONG-Adresse                   |
| -------------- | ---- | --------------------------------------------- | ------------------------------ |
| BidCos-RF      | 2001 | `/`                                           | `CENTRAL`                      |
| HmIP-RF        | 2010 | `/`                                           | `CENTRAL:0`                    |
| VirtualDevices | 9292 | nur `/groups` (sonst HTTP 404 wie an der CCU) | `CENTRAL` (in der UI änderbar) |

Läuft auf demselben Rechner eine CCU-Software oder ein anderer Dienst auf diesen Ports, andere Ports wählen.

## Homebridge-Testinstanz

**Nicht** die produktive Instanz verwenden: Discovery- und Paramset-Caches sowie `devices.json` liegen im Storage-Pfad und würden mit Mock-Daten überschrieben. Eigene Geräte aus `catalog/local/` haben dieselben Adressen wie im Haus.

```bash
homebridge -D -U ./hb-test
```

Konfiguration der Plattform in `hb-test/config.json`:

- `ccuIp: 127.0.0.1`, Ports 2001/2010, ohne TLS (`useTls: false`), keine `rpcAuth`
- `eventServer.callbackHost: 127.0.0.1`, `eventServer.port: 9875`
- Heizungsgruppen: `interfaces.virtualDevices: true` (ab 1.3.0-beta.0, Port 9292), dann Kanal 1 der Gruppe (`INT…:1`) als Thermostat zuordnen. In Home an die Gruppe schreiben, nicht an ein Mitglied: Ein Wert an ein Mitglied geht nur an dieses Gerät (die Gruppe folgt nur mit „Gruppe folgt Mitgliedern“)

Dann in der Mock-UI Geräte auswählen, in der Plugin-UI auf „Discover“ klicken, zuordnen und die Child-Bridge neu starten. Alternativ „CCU-Neustart simulieren“: Das Plugin meldet sich danach neu an und liest die Discovery neu.

## Katalog

| Ordner              | Inhalt                                                                                                                                     | im Repo |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| `catalog/pydevccu/` | Geräte- und `VALUES`-Beschreibungen aus [pydevccu](https://github.com/sukramj/pydevccu) 0.2.6 (MIT, siehe `LICENSE` dort), Adressen `VCU…` | ja      |
| `catalog/virtual/`  | Heizungsgruppen `HmIP-HEATING` und `HM-CC-VG-1`, gemessen an einer echten CCU (nur `INT…`-Adressen)                                        | ja      |
| `catalog/local/`    | eigene Dumps aus `dump-ccu.mjs` (echte Seriennummern)                                                                                      | nein    |

Neu erzeugen mit `import-catalog.mjs`:

```bash
node tools/ccu-mock/import-catalog.mjs pydevccu <pydevccu-0.2.6>/pydevccu
node tools/ccu-mock/import-catalog.mjs virtual  tools/ccu-probe/out/virtual-devices.json   # aus p03-spike.mjs
node tools/ccu-mock/import-catalog.mjs local    tools/ccu-probe/out/dump                   # aus dump-ccu.mjs
```

Angeboten werden nur Geräte mit mindestens einem Kanaltyp, den ein Service des Plugins kennt (`SERVICE_DEFINITIONS` in `dist/src/services/registry.js`). Fehlt `dist/`, zeigt der Mock alles. Wired-Geräte (`HMW-`) fallen weg. Interface: Gruppentypen → VirtualDevices, `HmIP`/`HmIPW`/`ELV-SH` → HmIP-RF, sonst BidCos-RF.

## Weboberfläche

- **Links:** Katalog mit Suche und Filtern. Die Checkbox entscheidet, ob `listDevices` das Gerät liefert (Standard: nichts ausgewählt). Änderungen schicken `newDevices`/`deleteDevices` an angemeldete Clients. „Instanz hinzufügen“ legt eine Kopie eines pydevccu-Typs mit neuer `VCU…`-Adresse an, „+ Gruppe …“ eine Heizungsgruppe `INT000000n`.
- **Rechts:** Datenpunkte des Geräts. „Setzen“ ändert nur den Wert im Mock, „Setzen + Event“ schickt ihn zusätzlich ans Plugin (wie eine Meldung vom Gerät). Pro Gerät: UNREACH, setValue-Fehler einmalig/dauerhaft, Verzögerung der setValue-Antwort.
- **Gruppen:** Mitglieder (ausgewählte HmIP-Thermostate bzw. BidCos-Thermostate), Schalter „Gruppe folgt Mitgliedern“ und „Gruppe meldet setValue zurück“.
- **Kopfzeile:** Anmeldungen je Interface, Schalter für Multicall, PONG, `LOW_BAT` an Kanal 0 der Gruppen, Fahrzeit der Rollläden, CCU-Neustart.
- **Unten:** Protokoll der letzten 200 Aufrufe und Events. `#n` verbindet ein `setValue` mit den Events, die es ausgelöst hat.

## Verhalten

- **setValue:** prüft Datenpunkt, Schreibrecht und dass FLOAT als `<double>` ankommt (sonst Fault). Danach: Standard = Event mit demselben Wert. HmIP-Receiver-Kanäle melden zusätzlich am Transmitter-Kanal davor. `ON_TIME` + `STATE=true` schaltet nach Ablauf aus. Rollläden fahren mit der eingestellten Fahrzeit (`ACTIVITY_STATE` bzw. `WORKING`/`DIRECTION`). Thermostate melden nur zurück; `CONTROL_MODE` (HmIP) → `SET_POINT_MODE`, `AUTO_MODE`/`MANU_MODE`/`BOOST_MODE` (BidCos) → `CONTROL_MODE`.
- **Gruppen:** Leere Gruppe: `setValue` → OK, aber nicht gespeichert und kein Event (gemessen). Mit Mitgliedern: Wert geht mit 100–500 ms Verzögerung an jedes Mitglied; die Gruppe meldet ihn über „Gruppe folgt Mitgliedern“ bzw. sofort mit „meldet setValue zurück“. Das ist angenommenes Verhalten, nicht gemessen.
- **`HM-CC-VG-1`:** `getParamset` liefert die Werte als Strings, wie die echte CCU. Events sind nach Beschreibung typisiert (nicht gemessen).
- **init:** HmIP-RF/BidCos-RF rufen `listDevices` und `newDevices` nach der Antwort auf `init` auf, VirtualDevices zusätzlich `setReadyConfig` je Gruppe, alles vor der Antwort (wie gemessen).
- **ping:** PONG an alle Clients des Interfaces. „PONG unterdrücken“ testet den STALE-Pfad nach 90 s.
- **CCU-Neustart:** verwirft alle Anmeldungen und antwortet für die eingestellte Dauer mit HTTP 503.
- **Fehler:** unbekannte Adresse → `-2 Unknown instance`, unbekannter Datenpunkt → `-5`, UNREACH (HmIP) → `setValue` `-1 Generic error (UNREACH)`, `getParamset` `{}`.

Auswahl, Instanzen, Gruppen, Werte und Schalter stehen in `state.json` (nicht im Repo) und überstehen einen Neustart.

## Grenzen

- Funk-Timing, ACK-Verluste und Duty Cycle nur über Verzögerung und Fehler.
- pydevccu-Beschreibungen stammen nicht aus der eigenen Firmware; einzelne Datenpunkte können abweichen. Mehrkanal-Geräte sind dort teils reduziert, dafür besser die eigenen Dumps nehmen.
- Kein TLS (42001/42010/49292), keine Authentifizierung.
