# Datenschutzerklärung / Privacy Policy

**Watcharr Scrobbler** — Browser-Erweiterung für Firefox und Chrome
(GitHub: <https://github.com/matimb0/Watcharr-Scrobbler>)

Zuletzt aktualisiert: 2026-09-28

---

## Deutsch

### 1. Worum es geht

Watcharr Scrobbler ist eine Erweiterung, die erkennt, was du auf **Netflix**,
**Prime Video** oder deinem **selbst gehosteten Jellyfin-Server** ansiehst, den
Titel über die **TMDB**-API einer TMDB-ID zuordnet und den gesehenen Status an
deine **selbst gehostete Watcharr-Instanz** meldet. Zusätzlich kannst du deine
vorhandene Anseh-Historie dieser Dienste ansehen, mit Watcharr abgleichen und
ausgewählte Einträge importieren oder als Datei exportieren.

**Es gibt keinen Server des Entwicklers.** Es gibt keine Analyse-, Telemetrie-
oder Werbefunktionen. Es werden keine Daten an den Entwickler oder an sonstige
Dritte verkauft oder übertragen.

### 2. Welche Daten verarbeitet werden

| Daten | Zweck |
| --- | --- |
| Zugangsdaten für deine Watcharr-Instanz (Benutzername, Passwort) sowie ggf. deine Jellyfin-Zugangsdaten oder ein Plex-Token | einmalige Anmeldung; das **Passwort wird nicht gespeichert** |
| Sitzungs-Token (JWT) deiner Watcharr-Instanz | authentifizierte Aufrufe deiner Watcharr-API |
| Zugriffs-Token deiner Jellyfin-Web-Client-Sitzung (aus dem localStorage des Jellyfin-Web-Clients) | Aufrufe deines Jellyfin-Servers (Wiedergabestatus, Historie) |
| Adresse deiner Watcharr- bzw. Jellyfin-Instanz | Ziel der API-Aufrufe |
| Titel, Serien-/Episodennamen, Staffel-/Episodennummer, Jahr, Wiedergabefortschritt und Anseh-Zeitpunkte der genannten Dienste | erkennen, zuordnen und melden, was du gesehen hast |
| Suchbegriffe (Titel) für die TMDB-Suche | Zuordnung zu einer TMDB-ID |
| Einstellungen (Schwellenwert für „gesehen“, Sprache, Aktiviert-Status, ggf. dein eigener TMDB-API-Schlüssel) | Funktion und Darstellung der Erweiterung |
| Lokaler Zuordnungs-Cache (Titel ↔ TMDB-ID) | dieselbe Zuordnung nicht erneut suchen zu müssen |

Deine Netzwerkadresse (IP) und technisch notwendige Verbindungsdaten fallen bei
den unten genannten Empfängern an, weil dorthin eine Verbindung aufgebaut wird.

### 3. Wo die Daten gespeichert werden

Ausschließlich **lokal in deinem Browser** auf deinem Gerät – dauerhaft in
`browser.storage.local`, die geladene Historie zusätzlich für die Dauer der
Browser-Sitzung in `browser.storage.session` (nur im Arbeitsspeicher, wird beim
Schließen des Browsers verworfen). Es werden keine Nutzerdaten auf Servern des
Entwicklers oder bei Dritten gespeichert.

### 4. Wohin Daten übertragen werden

Nur an die Stellen, die für die Funktion erforderlich sind – alle Zieladressen
(außer Netflix, Prime Video, TMDB und plex.tv) gibst **du** selbst ein:

- **Deine Watcharr-Instanz** (Adresse von dir): Login und Scrobbling.
- **Dein Jellyfin-Server** (Adresse von dir): Wiedergabestatus und Historie.
- **`api.themoviedb.org`**: Zuordnung von Titeln zu TMDB-IDs; es werden nur
  Suchbegriffe gesendet.
- **`*.plex.tv`**: nur wenn du die Plex-Anmeldung wählst (OAuth-Freigabe).
  Das dabei erhaltene Token wird an **deine** Watcharr-Instanz gesendet.
- **`*.netflix.com` / `*.primevideo.com`**: Anfragen aus dem Content-Script
  erfolgen ausschließlich im Kontext der jeweiligen Seite und mit deiner
  bestehenden Sitzung auf diesen Seiten.

Alle Übertragungen erfolgen über verschlüsselte Verbindungen (HTTPS/WSS),
soweit der jeweilige Dienst dies unterstützt.

### 5. Was nicht passiert

- Kein Verkauf und keine Übertragung von Nutzerdaten an Dritte.
- Keine Nutzung von Nutzerdaten für Zwecke, die nichts mit dem alleinigen Zweck
  der Erweiterung zu tun haben.
- Keine Nutzung von Nutzerdaten zur Ermittlung der Kreditwürdigkeit oder für
  Darlehenszwecke.
- Keine Werbung, kein Profiling, keine Analyse- oder Telemetriedaten.
- Kein Auslesen deines allgemeinen Browser-Verlaufs. Gelesen werden nur die
  Inhalte der Seiten der unterstützten Dienste (Netflix, Prime Video, Jellyfin).
- Kein Remote-Code: Die Erweiterung lädt und führt keinen Code aus, der nicht
  im Erweiterungspaket enthalten ist (kein `eval`, keine externen Skripte).

### 6. Speicherdauer und Löschung

Die Daten liegen in den lokalen Einstellungen der Erweiterung, bis du sie
löschst: Die Abmeldung in den Einstellungen löscht das Sitzungs-Token, und mit
dem Deinstallieren der Erweiterung werden alle lokal gespeicherten Daten aus dem
Browser entfernt.

### 7. Sicherheit

Nutzerdaten werden nur über gesicherte Verbindungen (HTTPS) übertragen. Das
Passwort wird nicht gespeichert, sondern nur einmalig zur Anmeldung an die von
dir angegebene Instanz gesendet. Da Watcharr und Jellyfin selbst gehostete
Dienste sind, kann auch eine unverschlüsselte HTTP-Adresse eingetragen werden;
das liegt in deiner Verantwortung.

### 8. Chrome Web Store – Limited Use

Die Nutzung der über die Erweiterung erhaltenen Informationen entspricht der
[Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq),
einschließlich der Anforderungen zur eingeschränkten Verwendung (Limited Use).
Nutzerdaten werden nur verwendet, um den oben beschriebenen, alleinigen Zweck der
Erweiterung zu erfüllen. Es findet keine Übertragung an Dritte statt, außer
soweit dies für die Funktion erforderlich ist (siehe Abschnitt 4).

### 9. Kontakt

Fragen oder Hinweise: <https://github.com/matimb0/Watcharr-Scrobbler/issues>

---

## English

### 1. What this extension does

Watcharr Scrobbler detects what you watch on **Netflix**, **Prime Video** or
your **self-hosted Jellyfin server**, matches the title to a TMDB ID via the
**TMDB** API, and reports the watched status to **your self-hosted Watcharr
instance**. It also lets you view the service's existing watch history, compare
it with Watcharr, and import or export selected entries as a file.

**There is no developer-operated server.** There is no analytics, telemetry or
advertising. No user data is sold or transferred to the developer or any other
third party.

### 2. Data the extension processes

| Data | Purpose |
| --- | --- |
| Credentials for your Watcharr instance (username, password) and, if used, your Jellyfin credentials or a Plex token | one-time sign-in; the **password is never stored** |
| Session token (JWT) for your Watcharr instance | authenticated calls to your Watcharr API |
| Access token of your Jellyfin web-client session (read from the Jellyfin web client's localStorage) | requests to your Jellyfin server (playback status, history) |
| Address of your Watcharr / Jellyfin instance | target of the API calls |
| Titles, series/episode names, season/episode numbers, year, playback progress and watch dates as reported by those services | detect, match and report what you watched |
| Search terms (titles) for the TMDB lookup | match an entry to a TMDB ID |
| Settings (finished threshold, language, enabled state, optional own TMDB API key) | behaviour and display of the extension |
| Local match cache (title ↔ TMDB ID) | avoid looking up the same match twice |

Your IP address and technically required connection data are processed by the
recipients listed in section 4, because a connection to them is established.

### 3. Where data is stored

Only **locally in your browser** on your device – permanently in
`browser.storage.local`, plus the loaded history for the duration of the browser
session in `browser.storage.session` (memory only, discarded when the browser is
closed). No user data is stored on developer or third-party servers.

### 4. Where data is transmitted

Only where required for the extension's functionality. Apart from Netflix,
Prime Video, TMDB and plex.tv, **you** enter every destination address yourself:

- **Your Watcharr instance** (address entered by you): login and scrobbling.
- **Your Jellyfin server** (address entered by you): playback status and history.
- **`api.themoviedb.org`**: matching titles to TMDB IDs; only search terms are sent.
- **`*.plex.tv`**: only if you choose the Plex sign-in (OAuth). The resulting
  token is sent to **your** Watcharr instance.
- **`*.netflix.com` / `*.primevideo.com`**: content-script requests are made in
  the context of those pages only, using your existing session there.

All transmissions use encrypted connections (HTTPS/WSS) wherever the respective
service supports it.

### 5. What does not happen

- No selling or transferring of user data to third parties.
- No use of user data for purposes unrelated to the extension's single purpose.
- No use of user data for creditworthiness or lending purposes.
- No advertising, no profiling, no analytics or telemetry.
- No reading of your general browsing history. Only the content of the
  supported service pages (Netflix, Prime Video, Jellyfin) is read.
- No remote code: the extension does not load or execute any code that is not
  part of the extension package (no `eval`, no external scripts).

### 6. Retention and deletion

Data stays in the extension's local settings until you delete it: signing out in
the settings clears the session token, and uninstalling the extension removes
all locally stored data from the browser.

### 7. Security

User data is transmitted over secure connections (HTTPS) only. The password is
not stored; it is sent once to the instance you specified in order to sign in.
Because Watcharr and Jellyfin are self-hosted, you may also enter an unencrypted
HTTP address — that is your responsibility.

### 8. Chrome Web Store – Limited Use

The use of information received through this extension adheres to the
[Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq),
including the Limited Use requirements. User data is used solely to fulfil the
extension's single purpose described above. No data is transferred to third
parties except as necessary for that functionality (see section 4).

### 9. Contact

Questions or feedback: <https://github.com/matimb0/Watcharr-Scrobbler/issues>
