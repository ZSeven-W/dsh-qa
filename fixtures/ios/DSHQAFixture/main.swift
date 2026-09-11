import UIKit

final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = FixtureViewController()
        window.makeKeyAndVisible()
        self.window = window
        return true
    }
}

final class FixtureViewController: UIViewController {
    private let appID = "dev.zseven.qa.fixture.ios"

    private let titleLabel = UILabel()
    private let nameField = UITextField()
    private let secretField = UITextField()
    private let applyButton = UIButton(type: .system)
    private let statusLabel = UILabel()
    private let markerLabel = UILabel()
    private let scrollView = UIScrollView()
    private let scrollContent = UIView()
    private let lastItem = UILabel()

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground

        titleLabel.text = "DSH QA Fixture"
        titleLabel.font = .boldSystemFont(ofSize: 22)
        titleLabel.accessibilityLabel = "App title"

        nameField.placeholder = "Enter your name"
        nameField.borderStyle = .roundedRect
        nameField.autocorrectionType = .no
        nameField.autocapitalizationType = .words
        nameField.accessibilityIdentifier = "qa.input.name"
        nameField.accessibilityLabel = "Name input"

        secretField.placeholder = "Secret value"
        secretField.borderStyle = .roundedRect
        secretField.isSecureTextEntry = true
        secretField.autocorrectionType = .no
        secretField.autocapitalizationType = .none
        secretField.accessibilityIdentifier = "qa.input.secret"
        secretField.accessibilityLabel = "Secret input"

        applyButton.setTitle("Apply", for: .normal)
        applyButton.accessibilityIdentifier = "qa.action.apply"
        applyButton.accessibilityLabel = "Apply"
        applyButton.addTarget(self, action: #selector(applyTapped), for: .touchUpInside)

        statusLabel.text = "Ready"
        statusLabel.font = .systemFont(ofSize: 18)
        statusLabel.accessibilityIdentifier = "qa.status.result"
        statusLabel.accessibilityLabel = "Status"
        statusLabel.accessibilityValue = statusLabel.text

        markerLabel.text = "STATE:" + appID
        markerLabel.font = .systemFont(ofSize: 12)
        markerLabel.textColor = .secondaryLabel
        markerLabel.accessibilityIdentifier = "qa.state.marker"
        markerLabel.accessibilityLabel = "State marker"
        markerLabel.accessibilityValue = markerLabel.text

        scrollView.accessibilityIdentifier = "qa.scroll.container"
        scrollView.accessibilityLabel = "Scroll container"
        scrollView.alwaysBounceVertical = true

        let topItem = UILabel()
        topItem.text = "Scroll top item"
        topItem.accessibilityLabel = "Scroll top item"

        lastItem.text = "Last item (offscreen)"
        lastItem.accessibilityIdentifier = "qa.item.last"
        lastItem.accessibilityLabel = "Last item"

        [titleLabel, nameField, secretField, applyButton, statusLabel, markerLabel, scrollView].forEach {
            $0.translatesAutoresizingMaskIntoConstraints = false
            view.addSubview($0)
        }
        scrollView.addSubview(scrollContent)
        scrollContent.translatesAutoresizingMaskIntoConstraints = false
        [topItem, lastItem].forEach {
            $0.translatesAutoresizingMaskIntoConstraints = false
            scrollContent.addSubview($0)
        }

        NSLayoutConstraint.activate([
            titleLabel.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 12),
            titleLabel.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16),

            nameField.topAnchor.constraint(equalTo: titleLabel.bottomAnchor, constant: 16),
            nameField.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16),
            nameField.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),
            nameField.heightAnchor.constraint(equalToConstant: 44),

            secretField.topAnchor.constraint(equalTo: nameField.bottomAnchor, constant: 12),
            secretField.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16),
            secretField.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),
            secretField.heightAnchor.constraint(equalToConstant: 44),

            applyButton.topAnchor.constraint(equalTo: secretField.bottomAnchor, constant: 16),
            applyButton.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16),
            applyButton.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),
            applyButton.heightAnchor.constraint(equalToConstant: 48),

            statusLabel.topAnchor.constraint(equalTo: applyButton.bottomAnchor, constant: 16),
            statusLabel.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16),

            markerLabel.topAnchor.constraint(equalTo: statusLabel.bottomAnchor, constant: 8),
            markerLabel.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16),

            scrollView.topAnchor.constraint(equalTo: markerLabel.bottomAnchor, constant: 12),
            scrollView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            scrollView.bottomAnchor.constraint(equalTo: view.bottomAnchor),

            scrollContent.topAnchor.constraint(equalTo: scrollView.contentLayoutGuide.topAnchor),
            scrollContent.leadingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.leadingAnchor),
            scrollContent.trailingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.trailingAnchor),
            scrollContent.bottomAnchor.constraint(equalTo: scrollView.contentLayoutGuide.bottomAnchor),
            scrollContent.widthAnchor.constraint(equalTo: scrollView.frameLayoutGuide.widthAnchor),

            topItem.topAnchor.constraint(equalTo: scrollContent.topAnchor, constant: 16),
            topItem.leadingAnchor.constraint(equalTo: scrollContent.leadingAnchor, constant: 16),

            lastItem.topAnchor.constraint(equalTo: topItem.bottomAnchor, constant: 1200),
            lastItem.leadingAnchor.constraint(equalTo: scrollContent.leadingAnchor, constant: 16),
            lastItem.bottomAnchor.constraint(equalTo: scrollContent.bottomAnchor, constant: -16),
        ])
    }

    @objc private func applyTapped() {
        let name = (nameField.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let result = "Hello " + name
        statusLabel.text = result
        markerLabel.text = "STATE:" + appID + ";status=" + result
        statusLabel.accessibilityValue = result
        markerLabel.accessibilityValue = "STATE:" + appID + ";status=" + result
    }
}

UIApplicationMain(
    CommandLine.argc,
    CommandLine.unsafeArgv,
    nil,
    NSStringFromClass(AppDelegate.self)
)
