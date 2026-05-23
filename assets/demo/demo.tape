# VHS tape for the Reviewgate README demo.
# Render with:  vhs assets/demo/demo.tape
# Produces:     docs/assets/demo.gif

Output docs/assets/demo.gif

Set Shell "bash"
Set Theme "Catppuccin Mocha"
Set FontSize 17
Set Width 1080
Set Height 720
Set Padding 28
Set Margin 0
Set PlaybackSpeed 1.0

Hide
Type "bash assets/demo/demo.sh"
Enter
Show

# Let the reenactment play out (script paces itself with sleeps ~23s total).
Sleep 25s
