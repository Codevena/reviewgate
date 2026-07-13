# VHS tape for the real Reviewgate Alpha.11 cassette replay.
# Render with:  vhs assets/demo/demo.tape
# Produces:     docs/assets/demo.gif

Output docs/assets/demo.gif

Set Shell "bash"
Set Theme "Catppuccin Mocha"
Set FontSize 16
Set Width 1080
Set Height 720
Set Padding 26
Set Margin 0
Set PlaybackSpeed 1.0

Hide
Type "REVIEWGATE_DEMO_DELAY=.45 bash assets/demo/demo.sh"
Enter
Show

Sleep 18s
