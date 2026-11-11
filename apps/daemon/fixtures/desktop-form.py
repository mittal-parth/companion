"""A small form one bot fills in.

The daemon starts one process per bot. Submit does nothing useful until the
terms are accepted and a name is entered. The window then shows a confirmation
code, and the same code is written to the result file the daemon passed in, so
a test can read what the form actually did.
"""

import json
import secrets
import sys

import gi

gi.require_version("Gtk", "3.0")
from gi.repository import GLib, Gtk

GLib.set_prgname("companion-form")


def main() -> None:
    if len(sys.argv) != 3:
        sys.stderr.write("usage: desktop-form.py RESULT_FILE TITLE\n")
        sys.exit(1)
    result_path, title = sys.argv[1], sys.argv[2]

    window = Gtk.Window(title=title)
    window.set_default_size(420, 240)
    box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
    box.set_border_width(12)
    window.add(box)

    box.pack_start(Gtk.Label(label="Name"), False, False, 0)
    entry = Gtk.Entry()
    box.pack_start(entry, False, False, 0)
    terms = Gtk.CheckButton(label="I accept the terms")
    box.pack_start(terms, False, False, 0)
    status = Gtk.Label(label="Waiting")
    box.pack_start(status, False, False, 0)

    def submit(_button: Gtk.Button) -> None:
        name = entry.get_text().strip()
        if name == "" or not terms.get_active():
            status.set_text("Please accept the terms")
            return
        code = "CF-" + secrets.token_hex(3)
        status.set_text("Confirmed " + code)
        with open(result_path, "w", encoding="utf-8") as result:
            json.dump({"code": code, "name": name}, result)

    button = Gtk.Button(label="Submit")
    button.connect("clicked", submit)
    box.pack_start(button, False, False, 0)
    window.connect("destroy", Gtk.main_quit)
    window.show_all()
    Gtk.main()


if __name__ == "__main__":
    main()
