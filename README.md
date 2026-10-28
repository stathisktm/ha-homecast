# Home Cast (Home Assistant add-on)

This add-on makes the Home Assistant machine appear in the **Cast** list of the **YouTube** and **YouTube Music** apps, the way a TV does. Whatever you cast plays on the machine's own speakers, through [Home Radio](https://github.com/stathisktm/ha-homeradio) and the VLC add-on. The queue, next/previous, pause, seeking and volume all work from the phone.

## Installation
1. In Home Assistant, go to **Settings → Add-ons → Add-on Store**.
2. Open **⋮ → Repositories** and add `https://github.com/stathisktm/ha-homecast`.
3. Find **Home Cast** in the store, then select **Install** and **Start**.

You need Home Radio 0.2.0 or later, and the phone must be on the same network.

## Limitations
- Spotify and TuneIn can't use it. They cast only through genuine Google Cast, which requires a device certificate issued by Google.
- It is built on [yt-cast-receiver](https://github.com/patrickkfkan/yt-cast-receiver). YouTube can change its protocol at any time.
