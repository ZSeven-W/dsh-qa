// dsh-qa isolated native macOS fixture (WP5).
//
// A minimal, fully self-built AppKit application with NO third-party or
// platform bundle id. It exposes, through macOS Accessibility:
//   - an ordinary editable text field (AXTextField)
//   - a secure password field (AXSecureTextField)
//   - a safe button that flips an observable status to a PASS string
//   - a "Publish release" control that must require host approval
//     (the driver's policy classifies "publish" as external-commit)
//
// Built and ad-hoc signed by fixtures/native/build-fixture.mjs; the bundle id
// dev.zseven-w.dsh-qa.fixture is owned by this repository only.

import AppKit

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusLabel: NSTextField!
    private var publishStateLabel: NSTextField!
    private var publishCount = 0

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 480, height: 340),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "dsh-qa native fixture"
        window.center()

        let content = NSView(frame: window.contentView?.bounds ?? NSRect(x: 0, y: 0, width: 480, height: 340))
        window.contentView = content

        var y: CGFloat = 300

        _ = addLabel("Plain text", to: content, y: y)
        y -= 24
        let plainField = NSTextField(frame: NSRect(x: 20, y: y, width: 320, height: 24))
        plainField.isEditable = true
        plainField.isSelectable = true
        plainField.placeholderString = "Type here"
        plainField.setAccessibilityLabel("Plain text")
        plainField.setAccessibilityIdentifier("fixture.plainText")
        content.addSubview(plainField)
        y -= 44

        _ = addLabel("Secure password", to: content, y: y)
        y -= 24
        let secureField = NSSecureTextField(frame: NSRect(x: 20, y: y, width: 320, height: 24))
        secureField.isEditable = true
        secureField.isSelectable = true
        secureField.placeholderString = "Password"
        secureField.setAccessibilityLabel("Secure password")
        secureField.setAccessibilityIdentifier("fixture.securePassword")
        content.addSubview(secureField)
        y -= 48

        let safeButton = NSButton(title: "Run validation", target: self, action: #selector(runValidation))
        safeButton.frame = NSRect(x: 20, y: y, width: 160, height: 28)
        safeButton.setAccessibilityIdentifier("fixture.safeAction")
        content.addSubview(safeButton)

        statusLabel = addLabel("IDLE", to: content, y: y + 4, x: 210)
        statusLabel.setAccessibilityIdentifier("fixture.status")
        y -= 48

        let publishButton = NSButton(title: "Publish release", target: self, action: #selector(publishRelease))
        publishButton.frame = NSRect(x: 20, y: y, width: 160, height: 28)
        publishButton.setAccessibilityIdentifier("fixture.publishRelease")
        content.addSubview(publishButton)

        publishStateLabel = addLabel("PUBLISHED: 0", to: content, y: y + 4, x: 210)
        publishStateLabel.setAccessibilityIdentifier("fixture.publishState")

        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc private func runValidation() {
        statusLabel.stringValue = "PASS: CU complete flow"
    }

    @objc private func publishRelease() {
        publishCount += 1
        publishStateLabel.stringValue = "PUBLISHED: \(publishCount)"
    }

    private func addLabel(_ text: String, to content: NSView, y: CGFloat, x: CGFloat = 20) -> NSTextField {
        let label = NSTextField(labelWithString: text)
        label.frame = NSRect(x: x, y: y, width: 300, height: 18)
        label.setAccessibilityLabel(text)
        content.addSubview(label)
        return label
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return true
    }

    private func buildMenu() {
        let mainMenu = NSMenu()
        let appMenuItem = NSMenuItem()
        mainMenu.addItem(appMenuItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Quit dsh-qa fixture", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appMenuItem.submenu = appMenu
        NSApp.mainMenu = mainMenu
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
