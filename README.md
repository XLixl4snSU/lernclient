# Lernclient

Statischer Lernclient für lokale Fragensammlungen und Spaced Repetition. Die Anwendung läuft vollständig im Browser und benötigt weder Serverlogik noch Nutzerkonten oder eine zentrale Datenbank.

## Funktionen

- Import und Aktualisierung von `.lernbank`-Fragensammlungen
- Single Choice, Multiple Choice, Matrix, Lückentext, Zuordnung, Sortieraufgaben und Drag & Drop auf Bildern
- eingebettete, offline nutzbare Bilder für alle Fragentypen
- dynamische FSRS-6-Wiederholungsplanung mit konfigurierbarer Erinnerungsquote
- kurze, frei konfigurierbare Lern- und Wiederlernschritte sowie Learn Ahead am Sitzungsende
- Live-Suche über Fragen und Lösungen mit Typ-, Punktzahl- und Lernstandfiltern
- Anzeige und Anpassung einzelner Wiederholungstermine
- Zurücksetzen einzelner Fragen oder des gesamten Lernfortschritts
- mehrere lokal gespeicherte Fragensammlungen
- Export und Wiederherstellung des vollständigen Lernstands als `.lernbackup`

## Lokal starten

Da JavaScript-Module verwendet werden, sollte der Client über einen lokalen HTTP-Server und nicht direkt als Datei geöffnet werden.

Im Verzeichnis dieses Repositorys:

```bash
python -m http.server 8000
```

Danach ist der Client unter `http://localhost:8000/` erreichbar.

Für Entwicklung und Tests werden die Abhängigkeiten einmalig installiert:

```bash
npm install
npm test
```

Die gepinnte `ts-fsrs`-Abhängigkeit wird als lokales Browsermodul unter `js/vendor/` mitgeliefert. Nach einem bewussten Update der Abhängigkeit wird diese Kopie mit `npm run vendor:fsrs` aktualisiert. Der Client lädt zur Laufzeit keine Bibliotheken aus dem Internet.

## Deployment

Der Lernclient benötigt keinen Build-Schritt. Für das Deployment wird der vollständige Inhalt dieses Repositorys unverändert auf einem statischen Webhost veröffentlicht. Die Verzeichnisstruktur von `index.html`, `css/` und `js/` einschließlich `js/vendor/` muss dabei erhalten bleiben.

### GitHub Pages

1. Repository zu GitHub pushen.
2. Unter **Settings → Pages** als Quelle **Deploy from a branch** auswählen.
3. Den gewünschten Branch und als Verzeichnis **/ (root)** festlegen.
4. Nach dem abgeschlossenen Deployment die von GitHub Pages angezeigte URL öffnen.

Die Anwendung verwendet relative Asset-Pfade und Hash-Routing. Sie kann daher sowohl auf einer eigenen Domain als auch in einem Unterverzeichnis wie `/lernclient/` bereitgestellt werden.

### Andere statische Webhosts

Alternativ kann der Repository-Inhalt auf jedem Host für statische Dateien veröffentlicht werden, beispielsweise über einen einfachen Webserver, Object Storage oder einen Static-Site-Dienst. Besondere Rewrite-Regeln oder serverseitige Funktionen sind nicht erforderlich.

## Lokale Daten und Backups

Fragensammlungen, Einstellungen und Lernfortschritt werden in IndexedDB im jeweiligen Browser gespeichert. Es gibt keine Cloud-Synchronisierung und keine automatische Backup-Datei.

Nutzer sollten nach jeder Lernsitzung selbst ein aktuelles `.lernbackup` herunterladen. Nur damit kann der Lernstand nach gelöschten Browserdaten oder auf einem anderen Gerät beziehungsweise in einem anderen Browser fortgesetzt werden.

- `.lernbank`: Fragensammlung importieren oder aktualisieren
- `.lernbackup`: Fragensammlung, Einstellungen und persönlichen Lernstand sichern oder wiederherstellen

Backups mit Scheduler-Version 1 werden beim Einlesen automatisch auf FSRS migriert. Vorhandene Fälligkeitstermine und gesperrte Karten bleiben dabei erhalten; Stabilität und Schwierigkeit werden soweit möglich aus der gespeicherten Bewertungshistorie rekonstruiert. Die alten SM-2-Einstellungen bleiben im Backup unter `legacySchedulerV1` erhalten, werden aber nicht mehr für neue Termine verwendet. Neu exportierte Backups verwenden Scheduler-Version 2.

## FSRS

FSRS modelliert für jede Karte Schwierigkeit, Gedächtnisstabilität und aktuelle Abrufwahrscheinlichkeit. Der Standard zielt auf 90 Prozent Erinnerungswahrscheinlichkeit. Neue Karten verwenden zunächst die Schritte `1m, 10m`; nach dem Vergessen einer bereits gelernten Karte gelten standardmäßig `1m, 10m`. Anschließend berechnet FSRS das nächste Intervall dynamisch aus dem bisherigen Lernverlauf.

Die mitgelieferte Implementierung stammt aus dem MIT-lizenzierten Paket [`ts-fsrs`](https://github.com/open-spaced-repetition/ts-fsrs). Die zugehörige Lizenz liegt neben dem Browsermodul unter `js/vendor/ts-fsrs.LICENSE.txt`.

Diese Dateitypen sind über `.gitignore` vom Repository ausgeschlossen und sollten nicht zusammen mit dem Client veröffentlicht werden.

## Datenschutz

Importierte Dateien werden direkt im Browser verarbeitet und nicht an einen Anwendungsserver übertragen.

Version-2-Dateien enthalten Bilder einmalig im zentralen Asset-Store. Der Client rendert ausschließlich diese eingebetteten Kopien und ist beim Lernen nicht von externen Bildservern abhängig. Alte Version-1-Dateien bleiben ladbar.
