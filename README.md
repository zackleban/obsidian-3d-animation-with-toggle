# 3D Animation with Toggle

Turns a vault with several subvaults in it into a 3D animation. In the graph view's controls, right below the
timelapse wand ("Start timelapse animation"), it adds:

- a cube button, **Start 3D animation**: plays the vault from day one, in 3D. Notes appear on the day they were made,
  next to a note they link to, and each subvault gathers into its own coloured cluster. The camera turns slowly and
  backs off to keep everything in view. The top left shows `Day 12 of 40 · Sep 21, 2026 · 16 notes`.
- a **2D / 3D** toggle: 2D is Obsidian's own graph; 3D shows the whole vault as it is now, in 3D. The choice is saved.
  Pressing the cube from 2D flips the toggle to 3D first.

Like the wand, both show while the graph settings panel is closed, and only in the global graph (not the local graph).

In 3D, drag to turn (it keeps going past the top and bottom, as freely as side to side), scroll to zoom, right-drag
to pan. Double-click to zoom in around the spot you clicked: that spot stays under the mouse while everything closes in.
Alt-double-click zooms back out the same way. Press and hold for a quarter second and the picture is in your hand (the
pointer turns into a closed hand): dragging then slides it left, right, up and down, without turning it, until you let
go. Hover a dot for the note's name and subvault; click it to open the note. The legend at the bottom left lists each subvault, its colour and how many notes it holds.

## Subvaults

A subvault is any folder that holds its own `.obsidian` folder. A vault with none of those is split by its top-level
folders instead. Notes outside every subvault form one group named after the vault.

## Days

Day 1 is the day the vault's oldest note was made (the file's creation date, the same date Obsidian's own timelapse
uses). A run takes 60 ms a day, at least 8 s and at most 40 s. Only notes (`.md`) are shown; links are the resolved
links between them. Graph filters and groups do not apply to the 3D view.

## Install by hand

Copy `main.js`, `manifest.json` and `styles.css` into `<your vault>/.obsidian/plugins/3d-animation-with-toggle/`, then
turn it on under Settings, Community plugins.

## Build

```
npm install
npm run build
```

`npm run dev` rebuilds on every save. Built with three.js and d3-force-3d (both MIT).
