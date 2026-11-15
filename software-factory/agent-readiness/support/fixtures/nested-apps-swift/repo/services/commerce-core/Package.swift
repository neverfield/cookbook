// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "CommerceCore",
    targets: [
        .target(name: "CommerceCore"),
        .testTarget(name: "CommerceCoreTests", dependencies: ["CommerceCore"]),
    ]
)
