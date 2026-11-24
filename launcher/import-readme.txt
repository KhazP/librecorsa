Circuits and cars to convert for LibreCorsa
==========================================

Copy a circuit's or a car's folder from another game here, then open the game's Mods panel: it lists each folder
with what it is, and converts one into a mod package (into the mods folder) when you press Convert.

  Assetto Corsa circuit   content/tracks/<name>          (models*.ini or a .kn5, and ui/ui_track.json)
  Assetto Corsa car       content/cars/<name>            (data.acd or data/car.ini, and a .kn5)
  Speed Dreams circuit    data/tracks/<category>/<name>  (its <name>.xml track definition)
  Speed Dreams car        data/cars/models/<name>        (its <name>.xml and its model)
  F1 25 circuit           a folder holding the circuit's .erp
  Your own circuit        a folder holding Blender's .glb export and its settings .json

Unzip archives first: a folder is converted, not a zip. Nothing in these folders is ever run; the converter reads
their files. Respect each one's licence: most are for your own use only, and a converted package keeps their credit
and licence.
