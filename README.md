# Lernclient

Rein statischer Lernclient. Keine Serverlogik, keine Accounts, keine zentrale Nutzerdatenbank.

## Betrieb

Die Dateien können direkt auf GitHub Pages veröffentlicht werden. Es gibt keinen Build-Schritt.

Lokaler Test:

```bash
cd ..
python -m http.server 8000
```

Dann `http://localhost:8000/learning-client/` öffnen.

## Daten

- `.lernbank`: Fragensammlung importieren oder aktualisieren
- `.lernbackup`: kompletten persönlichen Stand wiederherstellen
- IndexedDB: automatische lokale Speicherung zwischen Sitzungen

Der Client unterstützt aktuell:

- Single Choice
- Multiple Choice
- Choice Matrix
- Lückentext
- Zuordnung per Drag & Drop
- Zuordnung mit Linien
- Sortieraufgaben
- Spaced Repetition
- Fragenbrowser mit Volltextsuche über Fragen und Lösungen
- mehrere lokal gespeicherte Fragensammlungen
- Export eines vollständigen `.lernbackup`

## GitHub Pages ohne öffentliche Fragensammlung

Für GitHub Pages wird **nur der Inhalt dieses Ordners** veröffentlicht. `.lernbank`- und `.lernbackup`-Dateien gehören nicht ins Repository.

Die Nutzer erhalten ihre `.lernbank` weiterhin separat, z. B. über Discord, und wählen sie im Browser aus. Die Datei wird direkt im Browser gelesen und in IndexedDB gespeichert; der Lernclient besitzt keinen Upload-Endpunkt.

Hinweis zu Bildern: Falls eine Frage nur eine externe Bild-URL enthält, lädt der Browser dieses Bild direkt von der angegebenen Quelle. Der Client sendet dabei keinen Referrer, die Bildquelle sieht technisch aber weiterhin die IP-Adresse des abrufenden Nutzers. Für vollständig offline eingebettete Bilder könnte das Build-System später optional Assets in die `.lernbank` einbetten.
