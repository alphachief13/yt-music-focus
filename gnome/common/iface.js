// D-Bus interface shared by the native host (host/focus-host.js) and the
// GNOME Shell extension (extension/extension.js). JSON over strings keeps the
// interface small and lets the payload follow the Chrome side.
export const BUS_NAME = 'io.github.alphachief13.YtFocus';
export const OBJECT_PATH = '/io/github/alphachief13/YtFocus';

export const IFACE_XML = `
<node>
  <interface name="io.github.alphachief13.YtFocus">
    <method name="GetState"><arg type="s" direction="out" name="json"/></method>
    <method name="GetLibrary"><arg type="s" direction="out" name="json"/></method>
    <method name="Search">
      <arg type="s" direction="in" name="query"/>
      <arg type="s" direction="out" name="json"/>
    </method>
    <method name="Play">
      <arg type="s" direction="in" name="videoIdsJson"/>
      <arg type="i" direction="in" name="index"/>
    </method>
    <method name="Toggle"/>
    <method name="Next"/>
    <method name="Previous"/>
    <method name="Seek"><arg type="d" direction="in" name="seconds"/></method>
    <method name="SetVolume"><arg type="i" direction="in" name="volume"/></method>
    <method name="ToggleLikeCurrent"/>
    <method name="Like"><arg type="s" direction="in" name="trackJson"/></method>
    <method name="Unlike"><arg type="s" direction="in" name="videoId"/></method>
    <method name="CreatePlaylist">
      <arg type="s" direction="in" name="name"/>
      <arg type="s" direction="out" name="id"/>
    </method>
    <method name="DeletePlaylist"><arg type="s" direction="in" name="id"/></method>
    <method name="AddToPlaylist">
      <arg type="s" direction="in" name="id"/>
      <arg type="s" direction="in" name="trackJson"/>
    </method>
    <method name="RemoveFromPlaylist">
      <arg type="s" direction="in" name="id"/>
      <arg type="s" direction="in" name="videoId"/>
    </method>
    <method name="SetVideoMode"><arg type="s" direction="in" name="mode"/></method>
    <method name="SetFocus"><arg type="b" direction="in" name="on"/></method>
    <method name="ShowBrowser"/>
    <signal name="StateChanged"><arg type="s" name="json"/></signal>
    <signal name="LibraryChanged"><arg type="s" name="json"/></signal>
  </interface>
</node>`;
