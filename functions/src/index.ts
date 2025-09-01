/* eslint-disable max-len */
// import * as functions from 'firebase-functions';
import {initializeApp} from 'firebase-admin/app';
import {getFirestore, Timestamp} from 'firebase-admin/firestore';
import {onDocumentCreated, onDocumentDeleted} from 'firebase-functions/v2/firestore';
import {onSchedule} from 'firebase-functions/v2/scheduler';
import {defineSecret} from 'firebase-functions/params';
// import {onCustomEventPublished} from "firebase-functions/v2/eventarc";
import * as admin from 'firebase-admin';
// import {getStorage} from 'firebase-admin/storage';
// import {HttpsError, onCall} from 'firebase-functions/v2/https';
import {logger} from 'firebase-functions/v2';

initializeApp();
const db = getFirestore();
db.settings({ignoreUndefinedProperties: true});

// Define the Google API Key secret
const googleApiKeySecret = defineSecret('GOOGLE_API_KEY');
// Define the TypeScript interface for notifications
interface LocationNotification {
    title: string;
    body: string;
    address: string;
    state: string;
    eventName: string;
}

interface TrackNotification {
    startTime: FirebaseFirestore.Timestamp;
    endTime: FirebaseFirestore.Timestamp;
    avgSpeed: number;
    maxSpeed: number;
    distance: number;
    duration: number;
}

interface Notification {
    id: string;
    userId: string;
    circleId: string;
    userName: string;
    trackNotification: TrackNotification | undefined;
    locationNotification: LocationNotification | undefined;
    dateCreated: FirebaseFirestore.Timestamp;
}

interface CircleUser {
    id: string;
    role: string;
    authorization: string;
}

interface Circle {
    id: string;
    name: string;
    ownerId: string;
    dateCreated: Timestamp;
    users: [CircleUser] | undefined
}

/**
 * Gets the device token from the user document
 * @param {string} userId The userId field
 * @return {Promise<string> | null} The deviceToken or null
 */
async function getDeviceToken(userId: string): Promise<string | null> {
    try {
        const userQuerySnapshot = await db.collection('users').where('userId', '==', userId).get();

        if (userQuerySnapshot.empty) {
            console.warn(`No user found with userId: ${userId}`);
            return null;
        }

        const userDoc = userQuerySnapshot.docs[0]; // Assuming userId is unique
        const deviceToken = userDoc.data().deviceToken;

        console.log(`Found user document with ID: ${userDoc.id}`);
        console.log(`Device Token: ${deviceToken}`);

        return deviceToken || null;
    } catch (error) {
        console.error(`Error fetching device token for user ${userId}:`, error);
        return null;
    }
}

/**
 * Sends a Push Notification to the device
 * @param {string} deviceToken The users deviceToken
 * @param {string} title The notification title
 * @param {string} body The notification body
 * @return {Promise<string> | null} The deviceToken or null
 */
async function sendPushNotification(deviceToken: string, title: string, body: string) : Promise<string | null> {
    if (deviceToken) {
        const message = {
            token: deviceToken,
            notification: {
                title: title,
                body: body,
            },
        };

        console.log(message);
        return await admin.messaging().send(message);
    }

    return null;
}

/**
 * Sends a Silent Push Notification to the device
 * @param {string} deviceToken The users deviceToken
 * @param {string} content data content
 * @return {Promise<string> | null} The deviceToken or null
 */
async function sendSilentPushNotification(deviceToken: string, content: string): Promise<string | null> {
    if (deviceToken) {
        const message = {
            token: deviceToken,
            apns: {
                headers: {
                    'apns-push-type': 'background',
                    'apns-priority': '5',
                    // No apns-topic needed - Firebase auto-detects!
                },
                payload: {
                    aps: {
                        'content-available': 1,
                    },
                    shouldTrack: true,
                    timestamp: Date.now(),
                },
            },
        };

        console.log(JSON.stringify(message, null, 2));
        return await admin.messaging().send(message);
    }
    return null;
}

/**
 * deletes and entire sub collection
 * @param {FirebaseFirestore.CollectionReference} collectionRef The collection reference
 */
async function deleteSubCollection(collectionRef: admin.firestore.CollectionReference): Promise<void> {
    const snapshot = await collectionRef.get();
    await Promise.all(snapshot.docs.map(async (doc: admin.firestore.QueryDocumentSnapshot) => {
        await doc.ref.delete();
        console.log(`Deleted document ${doc.id} from sub-collection.`);
    }));

    Promise.resolve();
}

/**
 * Calculates the distance between two points on Earth using the Haversine formula
 * @param {number} lat1 Latitude of the first point in degrees
 * @param {number} lon1 Longitude of the first point in degrees
 * @param {number} lat2 Latitude of the second point in degrees
 * @param {number} lon2 Longitude of the second point in degrees
 * @return {number} Distance between the points in meters (consistent with existing GPS data)
 */
function calculateDistanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371000; // Earth's radius in meters
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c; // Distance in meters
}

/**
 * Calculates the course (bearing) between two points
 * @param {number} lat1 Latitude of the first point in degrees
 * @param {number} lon1 Longitude of the first point in degrees
 * @param {number} lat2 Latitude of the second point in degrees
 * @param {number} lon2 Longitude of the second point in degrees
 * @return {number} Course in degrees (0-360)
 */
function calculateCourse(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const lat1Rad = lat1 * Math.PI / 180;
    const lat2Rad = lat2 * Math.PI / 180;

    const y = Math.sin(dLon) * Math.cos(lat2Rad);
    const x = Math.cos(lat1Rad) * Math.sin(lat2Rad) - Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(dLon);

    let bearing = Math.atan2(y, x) * 180 / Math.PI;
    bearing = (bearing + 360) % 360; // Normalize to 0-360 degrees

    return bearing;
}

/**
 * Finds the closest original breadcrumb to a snapped point
 * @param {number} snappedLat Latitude of the snapped point
 * @param {number} snappedLon Longitude of the snapped point
 * @param {any[]} originalBreadcrumbs Array of original breadcrumbs
 * @return {any|null} The closest original breadcrumb or null
 */
function findClosestOriginalBreadcrumb(snappedLat: number, snappedLon: number, originalBreadcrumbs: any[]): any | null {
    if (!originalBreadcrumbs || originalBreadcrumbs.length === 0) {
        return null;
    }

    let closestBreadcrumb = null;
    let minDistance = Infinity;

    for (const breadcrumb of originalBreadcrumbs) {
        if (breadcrumb.latitude && breadcrumb.longitude) {
            const distance = calculateDistanceMeters(snappedLat, snappedLon, breadcrumb.latitude, breadcrumb.longitude);
            if (distance < minDistance) {
                minDistance = distance;
                closestBreadcrumb = breadcrumb;
            }
        }
    }

    return closestBreadcrumb;
}

/**
 * Interpolates timestamp for a snapped point based on its position relative to original breadcrumbs
 * @param {number} snappedLat Latitude of the snapped point
 * @param {number} snappedLon Longitude of the snapped point
 * @param {any[]} originalBreadcrumbs Array of original breadcrumbs (sorted by timestamp)
 * @param {number} snappedIndex Index of the snapped point in the snapped array
 * @param {number} totalSnappedPoints Total number of snapped points
 * @return {any|null} Interpolated timestamp or null
 */
function interpolateTimestamp(snappedLat: number, snappedLon: number, originalBreadcrumbs: any[], snappedIndex: number, totalSnappedPoints: number): any | null {
    if (!originalBreadcrumbs || originalBreadcrumbs.length < 2) {
        return null;
    }

    // Find the two closest original breadcrumbs that surround this snapped point
    const firstBreadcrumb = originalBreadcrumbs[0];
    const lastBreadcrumb = originalBreadcrumbs[originalBreadcrumbs.length - 1];

    if (!firstBreadcrumb.timestamp || !lastBreadcrumb.timestamp) {
        return null;
    }

    // Simple linear interpolation based on the snapped point's position in the sequence
    const progress = snappedIndex / (totalSnappedPoints - 1);
    const startTime = firstBreadcrumb.timestamp.toMillis();
    const endTime = lastBreadcrumb.timestamp.toMillis();
    const interpolatedTime = startTime + (endTime - startTime) * progress;

    // Convert back to Firestore Timestamp
    return admin.firestore.Timestamp.fromMillis(interpolatedTime);
}

export const onCircleDeleted = onDocumentDeleted('circles/{circleId}', async (event) => {
    const circleId = event.params.circleId;
    const deletedData = event.data?.data();
    const userId = deletedData?.userId;
    const circleName = deletedData?.name;

    console.log(`Document with ID ${circleId} was deleted.`);
    console.log('Deleted data:', deletedData);

    try {
        // Delete 'users' sub-collection under the deleted 'circles' document
        const users1Ref = db.collection(`circles/${circleId}/users`);
        await deleteSubCollection(users1Ref);
        console.log(`All documents in 'users' sub-collection under circle ${circleId} deleted.`);

        // Get the user document where the userId matches (only if userId exists)
        if (userId) {
            const deviceToken = await getDeviceToken(userId);
            // Send a notification to the user
            if (deviceToken) {
                await sendPushNotification(deviceToken, 'Circle Deleted', `Circle ${circleName || 'Unknown'} has been deleted.`);
            }
        } else {
            console.log('No userId found in deleted circle data, skipping notification');
        }

        // Optional: Handle other tasks that may need to be done asynchronously
    } catch (error) {
        console.error(`Error during circle deletion operation for circleId: ${circleId}`, error);
    }

    return Promise.resolve();
});

export const onCircleUserDeleted = onDocumentDeleted('circles/{circleId}/users/{userId}', async (event) => {
    const circleId = event.params.circleId;
    const userId = event.params.userId;
    const deletedData = event.data?.data();

    console.log(`Circle User document with circleId ${circleId} and userId ${userId} was deleted.`);
    console.log('Deleted data:', deletedData);

    try {
        // Query all users to check if their 'circles' sub-collection has any document referencing the deleted circleId
        const usersSnapshot = await db.collection('users').get();

        // Use Promise.all to process all users and their sub-collection deletions asynchronously
        await Promise.all(usersSnapshot.docs.map(async (userDoc) => {
            // Check the 'circles' sub-collection for matching documents
            // const circles2Ref = userDoc.ref.collection('circles').where('circleId', '==', circleId);
            // const circles2Snapshot = await circles2Ref.get();


            // Check the 'circleIds' list for matching documents
            const userData = userDoc.data();
            const circleIds = userData.circleIds;
            const newCircleIds = circleIds.filter((i: string) => i !== circleId);

            console.log(`User: ${userId} current circleIds ${circleIds} new circleIds ${newCircleIds}`);
            userDoc.ref.update({circleIds: newCircleIds});
            console.log(`User: ${userId} circleIds updated`);

            // // Loop over the found 'circles' documents and delete them
            // await Promise.all(circles2Snapshot.docs.map(async (circles2Doc) => {
            //     await circles2Doc.ref.delete();
            //     console.log(`Related 'users/circles' document with ID ${circles2Doc.id} deleted.`);
            // }));
        }));

        // Get the user document where the userId matches
        const deviceToken = await getDeviceToken(userId);

        // Send a notification to the user
        if (deviceToken) {
            await sendPushNotification(deviceToken, 'Removed from circle', 'You have been removed from a circle.');
        }

        // Optional: Handle other tasks that may need to be done asynchronously
    } catch (error) {
        console.error(`Error during circle user deletion operation for circleId: ${circleId} userId: ${userId}`, error);
    }

    return Promise.resolve();
});


export const onLocationEventCreated = onDocumentCreated('locationEvents/{id}', async (event) => {
    const snapshot = event.data;
    if (!snapshot) {
        console.log('No data associated with the event.');
        return;
    }

    const eventData = snapshot.data();
    // const userId = eventData.userId;
    const userName = eventData.userName;
    const eventName = eventData.eventName;
    const state = eventData.state;
    const circleId = eventData.circleId;
    const address = eventData.address;


    const id = event.params.id;
    console.log(`New location event created: ${id}`, eventData);
    // Perform additional operations, such as notifying users, logging, etc.

    // Reference the 'users' subcollection
    const circleCollectionRef = db.collection('circles').doc(`${circleId}`);
    const circleSnapshot = await circleCollectionRef.get();

    if (!circleSnapshot.exists) {
        console.log(`No circle found ${circleId}`);
        return;
    }

    const data = circleSnapshot.data();
    if (!data) {
        console.error('Data is undefined or null.');
        return null;
    }

    // Convert Firestore Timestamp to JavaScript Date
    const circle: Circle = {
        id: circleSnapshot.id,
        name: data.name || '', // Ensure name is a string
        ownerId: data.ownerId || '', // Ensure ownerId is a string
        dateCreated: data.dateCreated, // Handle Timestamp conversion
        users: data.users.map((user: CircleUser) => ({
            id: user.id || '', // Ensure id is a string
            role: user.role || '', // Ensure role is a string
            authorization: user.authorization || '', // Ensure authorization is a string
        })),
    };


    console.log(circle);

    if (!circle.users) {
        console.error('No user data.');
        return null;
    }

    // Process each user document asynchronously
    const userPromises = circle.users.map(async (user) => {
        // Get the user document where the userId matches
        // const deviceToken = await getDeviceToken(user.id);
        console.log(`Processing user ${user.id} in circle ${circle.id}:`);
        const action = state == 'arrived' ? 'arriving' : 'leaving';

        // Create notificaiton\message title and body
        const title = 'Location';
        const body = state == 'arrived' ? `${userName} is ${action} at ${eventName}.` : `${userName} is ${action} ${eventName}.`;

        // Create a new document reference to get the ID before writing
        const notificationRef = db.collection(`users/${user.id}/notifications`).doc();

        // Create a location notification object with strong typing
        const locationNotification: LocationNotification = {
            title: title,
            body: body,
            address: address,
            state: state,
            eventName: eventName,
        };

        // Create the notification object with strong typing
        const notificationData: Notification = {
            id: notificationRef.id, // Store the generated ID
            userId: user.id, // userId for the user that generated the event
            circleId: circleId, // The circleId
            userName: userName, // userName for the ser that generated th even
            trackNotification: undefined, // set undefined
            locationNotification: locationNotification, // Message Title
            dateCreated: Timestamp.now(), // Firestore timestamp
        };

        // Insert into user's 'notifications' subcollection
        notificationRef.set(notificationData);

        // Get the user document where the userId matches
        const deviceToken = await getDeviceToken(user.id);
        // Send a notification to the user
        if (deviceToken) {
            await sendPushNotification(deviceToken, title, body);
        }

        return Promise.resolve();
    });

    // Wait for all updates to complete
    await Promise.all(userPromises);

    return Promise.resolve();
});

/**
 * Creates a track notification for the user
 * @param {string} userId The user ID
 * @param {string} trackId The track ID
 * @param {any} trackData The track data
 */
async function createTrackNotification(userId: string, trackId: string, trackData: any): Promise<void> {
    try {
        logger.info(`${userId}: Creating track notification for track ${trackId}`);

        // Create a new document reference to get the ID before writing
        const notificationRef = db.collection(`users/${userId}/notifications`).doc();

        // Create a track notification object with strong typing
        const trackNotification: TrackNotification = {
            startTime: trackData.startTime,
            endTime: trackData.endTime,
            avgSpeed: trackData.avgSpeed,
            maxSpeed: trackData.maxSpeed,
            distance: trackData.distance,
            duration: trackData.duration,
        };

        // Create the notification object with strong typing
        const notificationData: Notification = {
            id: notificationRef.id, // Store the generated ID
            userId: userId, // userId for the user that generated the event
            circleId: 'circleId', // The circleId
            userName: trackData.name || 'Unknown User', // userName for the user that generated the event
            trackNotification: trackNotification,
            locationNotification: undefined, // set undefined for track notifications
            dateCreated: Timestamp.now(), // Firestore timestamp
        };

        // Insert into user's 'notifications' subcollection
        await notificationRef.set(notificationData);
        logger.info(`${userId}: Successfully created track notification for track ${trackId}`);
    } catch (error) {
        logger.error(`${userId}: Error creating track notification for track ${trackId}: ${error}`);
        // Don't throw - notification creation failure shouldn't stop other processing
    }
}

/**
 * Processes a track through Google Roads API for road snapping
 * @param {string} userId The user ID
 * @param {string} trackId The track ID
 * @param {any} trackData The track data
 * @param {admin.firestore.DocumentReference} trackRef The track document reference
 */
async function processTrackWithGoogleRoads(userId: string, trackId: string, trackData: any, trackRef: admin.firestore.DocumentReference): Promise<void> {
    try {
        logger.info(`${userId}: Starting Google Roads API processing for track ${trackId}`);

        // Validate breadcrumbs exist and meet minimum requirements for Roads processing
        if (!trackData.breadcrumbs || !Array.isArray(trackData.breadcrumbs) || trackData.breadcrumbs.length < 2) {
            logger.info(`${userId}: Track ${trackId} has insufficient breadcrumbs (${trackData.breadcrumbs?.length || 0}), skipping Roads processing`);
            return;
        }

        // Check if already processed to avoid reprocessing
        if (trackData.snappedToRoads === true) {
            logger.info(`${userId}: Track ${trackId} already processed with Google Roads, skipping Roads processing`);
            return;
        }

        logger.info(`${userId}: Processing ${trackData.breadcrumbs.length} breadcrumbs for track ${trackId} with Google Roads API`);

        // Sort breadcrumbs by timestamp (Firestore Timestamp objects) to ensure chronological order
        const breadcrumbs = [...trackData.breadcrumbs].sort((a, b) => {
            // Handle missing timestamps
            if (!a.timestamp && !b.timestamp) return 0;
            if (!a.timestamp) return 1;
            if (!b.timestamp) return -1;

            // For Firestore Timestamps, use toMillis() method
            const aTime = a.timestamp.toMillis();
            const bTime = b.timestamp.toMillis();

            return aTime - bTime;
        });

        logger.info(`${userId}: Sorted ${breadcrumbs.length} breadcrumbs chronologically for track ${trackId}`);

        // Get Google API key from Firebase secrets (Firebase v2)
        const googleApiKey = googleApiKeySecret.value();
        if (!googleApiKey) {
            logger.error(`${userId}: Google API key not configured in Firebase secrets, skipping Roads processing for track ${trackId}`);
            return;
        }

        // Google Roads API has a limit of 100 points per request, so we may need to batch
        const maxPointsPerRequest = 100;
        const batches = [];

        for (let i = 0; i < breadcrumbs.length; i += maxPointsPerRequest) {
            batches.push(breadcrumbs.slice(i, i + maxPointsPerRequest));
        }

        logger.info(`${userId}: Processing ${batches.length} batches for track ${trackId}`);

        let allSnappedPoints: any[] = [];

        // Process each batch
        for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
            const batch = batches[batchIndex];

            // Prepare path string for Google Roads API (lat,lng|lat,lng|...)
            const pathString = batch.map((breadcrumb: any) =>
                `${breadcrumb.latitude},${breadcrumb.longitude}`
            ).join('|');

            const url = `https://roads.googleapis.com/v1/snapToRoads?path=${encodeURIComponent(pathString)}&interpolate=true&key=${googleApiKey}`;

            logger.info(`${userId}: Calling Google Roads API for batch ${batchIndex + 1}/${batches.length} of track ${trackId}`);

            // Call Google Roads API
            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json',
                },
            });

            if (!response.ok) {
                const errorText = await response.text();
                logger.error(`${userId}: Google Roads API error for track ${trackId}, batch ${batchIndex + 1}: ${response.status} - ${errorText}`);

                // Mark as failed but don't throw to avoid retries
                await trackRef.update({
                    roadsProcessingFailed: true,
                    roadsProcessingError: `API error batch ${batchIndex + 1}: ${response.status}`,
                    roadsProcessedAt: admin.firestore.FieldValue.serverTimestamp(),
                });
                return;
            }

            const roadsResult = await response.json();

            // Validate response structure
            if (!roadsResult.snappedPoints || !Array.isArray(roadsResult.snappedPoints)) {
                logger.error(`${userId}: Invalid Google Roads API response for track ${trackId}, batch ${batchIndex + 1}`);

                await trackRef.update({
                    roadsProcessingFailed: true,
                    roadsProcessingError: `Invalid API response structure batch ${batchIndex + 1}`,
                    roadsProcessedAt: admin.firestore.FieldValue.serverTimestamp(),
                });
                return;
            }

            logger.info(`${userId}: Successfully snapped ${roadsResult.snappedPoints.length} points for batch ${batchIndex + 1} of track ${trackId}`);
            allSnappedPoints = allSnappedPoints.concat(roadsResult.snappedPoints);
        }

        logger.info(`${userId}: Successfully processed all batches with ${allSnappedPoints.length} total snapped points for track ${trackId}`);

        // Convert snapped points back to breadcrumb format with inferred data from original breadcrumbs
        const snappedBreadcrumbs = allSnappedPoints.map((snappedPoint: any, index: number) => {
            // Find the closest original breadcrumb to infer missing data
            const originalBreadcrumb = findClosestOriginalBreadcrumb(
                snappedPoint.location.latitude,
                snappedPoint.location.longitude,
                breadcrumbs
            );

            // Calculate speed and course if we have enough context
            const inferredSpeed = originalBreadcrumb?.speed !== null && originalBreadcrumb?.speed !== undefined ?
                originalBreadcrumb.speed :
                0.0;
            let inferredCourse = originalBreadcrumb?.course || null;
            let inferredTimestamp = originalBreadcrumb?.timestamp || null;

            // If we have previous snapped point, calculate course between them
            if (index > 0) {
                const prevSnapped = allSnappedPoints[index - 1];
                inferredCourse = calculateCourse(
                    prevSnapped.location.latitude,
                    prevSnapped.location.longitude,
                    snappedPoint.location.latitude,
                    snappedPoint.location.longitude
                );
            }

            // Interpolate timestamp if we have surrounding original points
            if (index > 0 && index < allSnappedPoints.length - 1) {
                inferredTimestamp = interpolateTimestamp(
                    snappedPoint.location.latitude,
                    snappedPoint.location.longitude,
                    breadcrumbs,
                    index,
                    allSnappedPoints.length
                );
            }

            return {
                latitude: snappedPoint.location.latitude,
                longitude: snappedPoint.location.longitude,
                // Inferred data from original breadcrumbs
                timestamp: inferredTimestamp,
                accuracy: null, // Road snapping replaces GPS accuracy
                altitude: originalBreadcrumb?.altitude || null, // Keep original altitude if available
                speed: inferredSpeed,
                course: inferredCourse,
                // Add snapping metadata
                wasSnapped: true,
                snappedIndex: index, // Index in the snapped array
                placeId: snappedPoint.placeId || null, // Google's place ID for the road
                originalBreadcrumbIndex: originalBreadcrumb ? breadcrumbs.indexOf(originalBreadcrumb) : null,
            };
        });

        // Calculate distance using the snapped coordinates (in meters for consistency with GPS data)
        let totalDistanceMeters = 0;
        for (let i = 1; i < snappedBreadcrumbs.length; i++) {
            const prev = snappedBreadcrumbs[i - 1];
            const curr = snappedBreadcrumbs[i];
            totalDistanceMeters += calculateDistanceMeters(prev.latitude, prev.longitude, curr.latitude, curr.longitude);
        }

        // Update the track document with snapped data
        const updateData: any = {
            breadcrumbs: trackData.breadcrumbs, // Keep original for reference
            enhancedBreadcrumbs: snappedBreadcrumbs,
            snappedToRoads: true,
            distance: totalDistanceMeters, // Use calculated distance from snapped points (in meters)
            roadsProcessingFailed: false,
            roadsProcessedAt: admin.firestore.FieldValue.serverTimestamp(),
        };

        await trackRef.update(updateData);

        logger.info(`${userId}: Successfully updated track ${trackId} with ${snappedBreadcrumbs.length} snapped breadcrumbs`);
        logger.info(`${userId}: Updated distance from ${(trackData.distance || 0).toFixed(2)} meters to ${totalDistanceMeters.toFixed(2)} meters for track ${trackId}`);
    } catch (error) {
        logger.error(`${userId}: Error processing track ${trackId} with Google Roads API: ${error}`);

        // Mark as failed but don't throw to avoid infinite retries
        try {
            await trackRef.update({
                roadsProcessingFailed: true,
                roadsProcessingError: error instanceof Error ? error.message : 'Unknown error',
                roadsProcessedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
        } catch (updateError) {
            logger.error(`${userId}: Failed to update error status for track ${trackId}: ${updateError}`);
        }
    }
}

/**
 * Processes a track through Google Directions API for route optimization
 * @param {string} userId The user ID
 * @param {string} trackId The track ID
 * @param {any} trackData The track data
 * @param {admin.firestore.DocumentReference} trackRef The track document reference
 */
async function processTrackWithGoogleDirections(userId: string, trackId: string, trackData: any, trackRef: admin.firestore.DocumentReference): Promise<void> {
    try {
        logger.info(`${userId}: Starting Google Directions API processing for track ${trackId}`);

        // Validate breadcrumbs exist and meet minimum requirements for Directions processing
        if (!trackData.breadcrumbs || !Array.isArray(trackData.breadcrumbs) || trackData.breadcrumbs.length < 2) {
            logger.info(`${userId}: Track ${trackId} has insufficient breadcrumbs (${trackData.breadcrumbs?.length || 0}), skipping Directions processing`);
            return;
        }

        // Check if already processed to avoid reprocessing
        if (trackData.processedWithDirections === true) {
            logger.info(`${userId}: Track ${trackId} already processed with Google Directions, skipping Directions processing`);
            return;
        }

        logger.info(`${userId}: Processing ${trackData.breadcrumbs.length} breadcrumbs for track ${trackId} with Google Directions API`);

        // Sort breadcrumbs by timestamp (Firestore Timestamp objects) to ensure chronological order
        const breadcrumbs = [...trackData.breadcrumbs].sort((a, b) => {
            // Handle missing timestamps
            if (!a.timestamp && !b.timestamp) return 0;
            if (!a.timestamp) return 1;
            if (!b.timestamp) return -1;

            // For Firestore Timestamps, use toMillis() method
            const aTime = a.timestamp.toMillis();
            const bTime = b.timestamp.toMillis();

            return aTime - bTime;
        });

        logger.info(`${userId}: Sorted ${breadcrumbs.length} breadcrumbs chronologically for track ${trackId}`);

        // Get Google API key from Firebase secrets (Firebase v2)
        const googleApiKey = googleApiKeySecret.value();
        if (!googleApiKey) {
            logger.error(`${userId}: Google API key not configured in Firebase secrets, skipping Directions processing for track ${trackId}`);
            return;
        }

        // Get start and end points from breadcrumbs
        const startPoint = breadcrumbs[0];
        const endPoint = breadcrumbs[breadcrumbs.length - 1];

        if (!startPoint.latitude || !startPoint.longitude || !endPoint.latitude || !endPoint.longitude) {
            logger.error(`${userId}: Invalid start or end coordinates for track ${trackId}`);
            return;
        }

        logger.info(`${userId}: Original track bounds - Start: lat=${(startPoint.latitude || 0).toFixed(6)}, lng=${(startPoint.longitude || 0).toFixed(6)}, End: lat=${(endPoint.latitude || 0).toFixed(6)}, lng=${(endPoint.longitude || 0).toFixed(6)}`);

        // Prepare waypoints for Directions API (excluding start and end points)
        const allWaypoints = breadcrumbs.slice(1, -1).map((breadcrumb: any) =>
            `${breadcrumb.latitude},${breadcrumb.longitude}`
        );

        // Google Directions API has a limit of 23 waypoints (25 total points including origin/destination)
        const maxWaypointsPerRequest = 23;

        // Waypoint selection strategy
        const waypointSelectionStrategy = ('evenly_distributed' as 'evenly_distributed' | 'curvature_based' | 'distance_based'); // Options: 'evenly_distributed', 'curvature_based', 'distance_based'

        /**
         * Select waypoints evenly distributed across the entire track
         * @param {string[]} allWaypoints Array of waypoint strings
         * @param {number} maxCount Maximum number of waypoints to select
         * @return {string[]} Selected waypoints
         */
        const selectEvenlyDistributedWaypoints = (allWaypoints: string[], maxCount: number): string[] => {
            if (allWaypoints.length <= maxCount) return allWaypoints;

            const step = (allWaypoints.length - 1) / (maxCount - 1);
            const selected = [];

            for (let i = 0; i < maxCount; i++) {
                const index = Math.round(i * step);
                selected.push(allWaypoints[index]);
            }

            return selected;
        };

        /**
         * Select waypoints based on route curvature (turns, direction changes)
         * @param {string[]} allWaypoints Array of waypoint strings
         * @param {number} maxCount Maximum number of waypoints to select
         * @return {string[]} Selected waypoints
         */
        const selectCurvatureBasedWaypoints = (allWaypoints: string[], maxCount: number): string[] => {
            if (allWaypoints.length <= maxCount) return allWaypoints;

            // Convert waypoint strings back to breadcrumb objects for calculation
            const waypointBreadcrumbs = breadcrumbs.slice(1, -1);

            // Calculate course changes between consecutive points
            const courseChanges = [];
            for (let i = 1; i < waypointBreadcrumbs.length - 1; i++) {
                const prev = waypointBreadcrumbs[i - 1];
                const curr = waypointBreadcrumbs[i];
                const next = waypointBreadcrumbs[i + 1];

                const course1 = calculateCourse(prev.latitude, prev.longitude, curr.latitude, curr.longitude);
                const course2 = calculateCourse(curr.latitude, curr.longitude, next.latitude, next.longitude);

                const courseChange = Math.abs(course2 - course1);
                courseChanges.push({index: i, change: courseChange});
            }

            // Sort by course change (highest first) and take top waypoints
            courseChanges.sort((a, b) => b.change - a.change);
            const selectedIndices = courseChanges.slice(0, maxCount).map((item) => item.index);

            // Sort indices to maintain order
            selectedIndices.sort((a, b) => a - b);

            return selectedIndices.map((i) => allWaypoints[i]);
        };

        /**
         * Select waypoints based on distance from start (evenly spaced)
         * @param {string[]} allWaypoints Array of waypoint strings
         * @param {number} maxCount Maximum number of waypoints to select
         * @return {string[]} Selected waypoints
         */
        const selectDistanceBasedWaypoints = (allWaypoints: string[], maxCount: number): string[] => {
            if (allWaypoints.length <= maxCount) return allWaypoints;

            const waypointBreadcrumbs = breadcrumbs.slice(1, -1);

            // Calculate total distance
            let totalDistance = 0;
            for (let i = 1; i < waypointBreadcrumbs.length; i++) {
                totalDistance += calculateDistanceMeters(
                    waypointBreadcrumbs[i-1].latitude, waypointBreadcrumbs[i-1].longitude,
                    waypointBreadcrumbs[i].latitude, waypointBreadcrumbs[i].longitude
                );
            }

            const targetDistance = totalDistance / (maxCount - 1);
            const selected = [];
            let currentDistance = 0;

            selected.push(allWaypoints[0]); // Always include first waypoint

            for (let i = 1; i < waypointBreadcrumbs.length; i++) {
                currentDistance += calculateDistanceMeters(
                    waypointBreadcrumbs[i-1].latitude, waypointBreadcrumbs[i-1].longitude,
                    waypointBreadcrumbs[i].latitude, waypointBreadcrumbs[i].longitude
                );

                if (currentDistance >= targetDistance * (selected.length) && selected.length < maxCount - 1) {
                    selected.push(allWaypoints[i]);
                }
            }

            // Always include last waypoint if not already included
            if (selected.length < maxCount && !selected.includes(allWaypoints[allWaypoints.length - 1])) {
                selected.push(allWaypoints[allWaypoints.length - 1]);
            }

            return selected;
        };

        // Select waypoints based on chosen strategy
        let selectedWaypoints: string[];
        switch (waypointSelectionStrategy) {
        case 'curvature_based':
            selectedWaypoints = selectCurvatureBasedWaypoints(allWaypoints, maxWaypointsPerRequest);
            logger.info(`${userId}: Using curvature-based waypoint selection for track ${trackId}`);
            break;
        case 'distance_based':
            selectedWaypoints = selectDistanceBasedWaypoints(allWaypoints, maxWaypointsPerRequest);
            logger.info(`${userId}: Using distance-based waypoint selection for track ${trackId}`);
            break;
        case 'evenly_distributed':
        default:
            selectedWaypoints = selectEvenlyDistributedWaypoints(allWaypoints, maxWaypointsPerRequest);
            logger.info(`${userId}: Using evenly distributed waypoint selection for track ${trackId}`);
            break;
        }

        logger.info(`${userId}: Selected ${selectedWaypoints.length} waypoints from ${allWaypoints.length} total waypoints for track ${trackId}`);

        // Build the Directions API URL with selected waypoints
        const origin = `${startPoint.latitude},${startPoint.longitude}`;
        const destination = `${endPoint.latitude},${endPoint.longitude}`;
        const waypointsParam = selectedWaypoints.length > 0 ? `&waypoints=${encodeURIComponent(selectedWaypoints.join('|'))}` : '';

        const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}${waypointsParam}&mode=driving&key=${googleApiKey}`;

        logger.info(`${userId}: Calling Google Directions API for track ${trackId}`);

        // Call Google Directions API
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
            },
        });

        if (!response.ok) {
            const errorText = await response.text();
            logger.error(`${userId}: Google Directions API error for track ${trackId}: ${response.status} - ${errorText}`);

            // Mark as failed but don't throw to avoid retries
            await trackRef.update({
                directionsProcessingFailed: true,
                directionsProcessingError: `API error: ${response.status}`,
                directionsProcessedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
            return;
        }

        const directionsResult = await response.json();

        // Validate response structure
        if (directionsResult.status !== 'OK' || !directionsResult.routes || directionsResult.routes.length === 0) {
            logger.error(`${userId}: Invalid Google Directions API response for track ${trackId}: ${directionsResult.status}`);

            await trackRef.update({
                directionsProcessingFailed: true,
                directionsProcessingError: `Invalid API response: ${directionsResult.status}`,
                directionsProcessedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
            return;
        }

        // Get the first (best) route
        const route = directionsResult.routes[0];
        const legs = route.legs;

        if (!legs || legs.length === 0) {
            logger.error(`${userId}: No route legs found for track ${trackId}`);
            return;
        }

        logger.info(`${userId}: Successfully got route with ${legs.length} legs for track ${trackId}`);

        // Extract all steps from all legs to create the route path
        const allSteps: any[] = [];
        legs.forEach((leg: any) => {
            if (leg.steps && Array.isArray(leg.steps)) {
                allSteps.push(...leg.steps);
            }
        });

        // Create enhanced breadcrumbs from the route
        const enhancedBreadcrumbs: any[] = [];
        let currentIndex = 0;

        // Add start point
        enhancedBreadcrumbs.push({
            latitude: startPoint.latitude,
            longitude: startPoint.longitude,
            timestamp: startPoint.timestamp,
            altitude: startPoint.altitude || null,
            speed: startPoint.speed !== null && startPoint.speed !== undefined ? startPoint.speed : 0.0,
            course: startPoint.course || null,
            index: currentIndex++,
            originalBreadcrumbIndex: 0,
        });

        // Process each step to extract intermediate points
        for (let i = 0; i < allSteps.length; i++) {
            const step = allSteps[i];

            // Decode the polyline to get intermediate points
            if (step.polyline && step.polyline.points) {
                const decodedPoints = decodePolyline(step.polyline.points);

                // Add intermediate points (skip first point as it's the same as previous step's end)
                for (let j = 1; j < decodedPoints.length; j++) {
                    const point = decodedPoints[j];

                    // Find the closest original breadcrumb to infer timing
                    const closestOriginal = findClosestOriginalBreadcrumb(
                        point.lat,
                        point.lng,
                        breadcrumbs
                    );

                    // Interpolate timestamp based on progress through the route
                    const progress = (i * decodedPoints.length + j) / (allSteps.length * decodedPoints.length);
                    const startTime = startPoint.timestamp.toMillis();
                    const endTime = endPoint.timestamp.toMillis();
                    const interpolatedTime = startTime + (endTime - startTime) * progress;

                    // Calculate speed and course
                    const inferredSpeed = closestOriginal?.speed !== null && closestOriginal?.speed !== undefined ?
                        closestOriginal.speed :
                        0.0;
                    let inferredCourse = null;

                    if (j > 0) {
                        const prevPoint = decodedPoints[j - 1];
                        inferredCourse = calculateCourse(
                            prevPoint.lat,
                            prevPoint.lng,
                            point.lat,
                            point.lng
                        );
                    }

                    enhancedBreadcrumbs.push({
                        latitude: point.lat,
                        longitude: point.lng,
                        timestamp: admin.firestore.Timestamp.fromMillis(interpolatedTime),
                        // accuracy: null, // Route-based accuracy
                        altitude: closestOriginal?.altitude || null,
                        speed: inferredSpeed,
                        course: inferredCourse,
                        // speedLimit: null, // Google Directions API doesn't provide speed limits
                        // wasProcessedWithDirections: true,
                        index: currentIndex++,
                        originalBreadcrumbIndex: closestOriginal ? breadcrumbs.indexOf(closestOriginal) : null,
                        // stepDistance: step.distance?.value || null, // Distance in meters
                        // stepDuration: step.duration?.value || null, // Duration in seconds
                    });

                    // Log first few points for debugging
                    if (currentIndex <= 3) {
                        logger.info(`${userId}: Enhanced breadcrumb ${currentIndex-1}: lat=${(point.lat || 0).toFixed(6)}, lng=${(point.lng || 0).toFixed(6)}`);
                    }
                }
            }
        }

        // Add end point if not already included
        if (enhancedBreadcrumbs.length === 0 ||
            enhancedBreadcrumbs[enhancedBreadcrumbs.length - 1].latitude !== endPoint.latitude ||
            enhancedBreadcrumbs[enhancedBreadcrumbs.length - 1].longitude !== endPoint.longitude) {
            enhancedBreadcrumbs.push({
                latitude: endPoint.latitude,
                longitude: endPoint.longitude,
                timestamp: endPoint.timestamp,
                altitude: endPoint.altitude || null,
                speed: endPoint.speed !== null && endPoint.speed !== undefined ? endPoint.speed : 0.0,
                course: endPoint.course || null,
                wasProcessedWithDirections: true,
                index: currentIndex++,
                originalBreadcrumbIndex: breadcrumbs.length - 1,
            });
        }

        // Calculate total distance and duration from the route
        const totalDistanceMeters = legs.reduce((sum: number, leg: any) =>
            sum + (leg.distance?.value || 0), 0
        );
        const totalDurationSeconds = legs.reduce((sum: number, leg: any) =>
            sum + (leg.duration?.value || 0), 0
        );

        // Calculate average speed from route data
        const avgSpeedMps = totalDurationSeconds > 0 ? totalDistanceMeters / totalDurationSeconds : 0;
        const avgSpeedKph = avgSpeedMps * 3.6; // Convert m/s to km/h

        // Update the existing track with enhanced data
        const updateData = {
            enhancedBreadcrumbs: enhancedBreadcrumbs,
            processedWithDirections: true,
            directionsProcessingFailed: false,
            directionsProcessedAt: admin.firestore.FieldValue.serverTimestamp(),
            waypointSelectionStrategy: waypointSelectionStrategy, // Store which approach was used
            routeSummary: {
                totalDistance: totalDistanceMeters,
                totalDuration: totalDurationSeconds,
                averageSpeed: avgSpeedKph,
                waypointCount: selectedWaypoints.length,
                legCount: legs.length,
                routePolyline: route.overview_polyline?.points || null,
            },
            // Update distance and duration with route data if available
            ...(totalDistanceMeters > 0 && {distance: totalDistanceMeters}),
            ...(totalDurationSeconds > 0 && {duration: totalDurationSeconds}),
            // Update average speed if calculated
            ...(avgSpeedKph > 0 && {avgSpeed: avgSpeedKph}),
        };

        await trackRef.update(updateData);

        logger.info(`${userId}: Successfully updated track ${trackId} with ${enhancedBreadcrumbs.length} enhanced breadcrumbs`);
        logger.info(`${userId}: Route distance: ${totalDistanceMeters.toFixed(2)} meters, duration: ${totalDurationSeconds.toFixed(2)} seconds`);
    } catch (error) {
        logger.error(`${userId}: Error processing track ${trackId} with Google Directions API: ${error}`);

        // Mark as failed but don't throw to avoid infinite retries
        try {
            await trackRef.update({
                directionsProcessingFailed: true,
                directionsProcessingError: error instanceof Error ? error.message : 'Unknown error',
                directionsProcessedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
        } catch (updateError) {
            logger.error(`${userId}: Failed to update error status for track ${trackId}: ${updateError}`);
        }
    }
}

/**
 * Processes a track through Google Routes API for route optimization
 * @param {string} userId The user ID
 * @param {string} trackId The track ID
 * @param {any} trackData The track data
 * @param {admin.firestore.DocumentReference} trackRef The track document reference
 */
async function processTrackWithGoogleRoutes(userId: string, trackId: string, trackData: any, trackRef: admin.firestore.DocumentReference): Promise<void> {
    try {
        logger.info(`${userId}: Starting Google Routes API processing for track ${trackId}`);

        // Validate breadcrumbs exist and meet minimum requirements for Routes processing
        if (!trackData.breadcrumbs || !Array.isArray(trackData.breadcrumbs) || trackData.breadcrumbs.length < 2) {
            logger.info(`${userId}: Track ${trackId} has insufficient breadcrumbs (${trackData.breadcrumbs?.length || 0}), skipping Routes processing`);
            return;
        }

        // Check if already processed to avoid reprocessing
        if (trackData.processedWithRoutes === true) {
            logger.info(`${userId}: Track ${trackId} already processed with Google Routes, skipping Routes processing`);
            return;
        }

        logger.info(`${userId}: Processing ${trackData.breadcrumbs.length} breadcrumbs for track ${trackId} with Google Routes API`);

        // Sort breadcrumbs by timestamp (Firestore Timestamp objects) to ensure chronological order
        const breadcrumbs = [...trackData.breadcrumbs].sort((a, b) => {
            // Handle missing timestamps
            if (!a.timestamp && !b.timestamp) return 0;
            if (!a.timestamp) return 1;
            if (!b.timestamp) return -1;

            // For Firestore Timestamps, use toMillis() method
            const aTime = a.timestamp.toMillis();
            const bTime = b.timestamp.toMillis();

            return aTime - bTime;
        });

        logger.info(`${userId}: Sorted ${breadcrumbs.length} breadcrumbs chronologically for track ${trackId}`);

        // Get Google API key from Firebase secrets (Firebase v2)
        const googleApiKey = googleApiKeySecret.value();
        if (!googleApiKey) {
            logger.error(`${userId}: Google API key not configured in Firebase secrets, skipping Routes processing for track ${trackId}`);
            return;
        }

        // Get start and end points from breadcrumbs
        const startPoint = breadcrumbs[0];
        const endPoint = breadcrumbs[breadcrumbs.length - 1];

        if (!startPoint.latitude || !startPoint.longitude || !endPoint.latitude || !endPoint.longitude) {
            logger.error(`${userId}: Invalid start or end coordinates for track ${trackId}`);
            return;
        }

        logger.info(`${userId}: Original track bounds - Start: lat=${(startPoint.latitude || 0).toFixed(6)}, lng=${(startPoint.longitude || 0).toFixed(6)}, End: lat=${(endPoint.latitude || 0).toFixed(6)}, lng=${(endPoint.longitude || 0).toFixed(6)}`);

        // Prepare waypoints for Routes API (excluding start and end points)
        const allWaypoints = breadcrumbs.slice(1, -1).map((breadcrumb: any) =>
            `${breadcrumb.latitude},${breadcrumb.longitude}`
        );

        // Google Routes API has a limit of 25 waypoints (25 total points including origin/destination)
        const maxWaypointsPerRequest = 25;

        // Waypoint selection strategy
        const waypointSelectionStrategy = ('evenly_distributed' as 'evenly_distributed' | 'curvature_based' | 'distance_based'); // Options: 'evenly_distributed', 'curvature_based', 'distance_based'

        /**
         * Select waypoints evenly distributed across the entire track
         * @param {string[]} allWaypoints Array of waypoint strings
         * @param {number} maxCount Maximum number of waypoints to select
         * @return {string[]} Selected waypoints
         */
        const selectEvenlyDistributedWaypoints = (allWaypoints: string[], maxCount: number): string[] => {
            if (allWaypoints.length <= maxCount) return allWaypoints;

            const step = (allWaypoints.length - 1) / (maxCount - 1);
            const selected = [];

            for (let i = 0; i < maxCount; i++) {
                const index = Math.round(i * step);
                selected.push(allWaypoints[index]);
            }

            return selected;
        };

        /**
         * Select waypoints based on route curvature (turns, direction changes)
         * @param {string[]} allWaypoints Array of waypoint strings
         * @param {number} maxCount Maximum number of waypoints to select
         * @return {string[]} Selected waypoints
         */
        const selectCurvatureBasedWaypoints = (allWaypoints: string[], maxCount: number): string[] => {
            if (allWaypoints.length <= maxCount) return allWaypoints;

            // Convert waypoint strings back to breadcrumb objects for calculation
            const waypointBreadcrumbs = breadcrumbs.slice(1, -1);

            // Calculate course changes between consecutive points
            const courseChanges = [];
            for (let i = 1; i < waypointBreadcrumbs.length - 1; i++) {
                const prev = waypointBreadcrumbs[i - 1];
                const curr = waypointBreadcrumbs[i];
                const next = waypointBreadcrumbs[i + 1];

                const course1 = calculateCourse(prev.latitude, prev.longitude, curr.latitude, curr.longitude);
                const course2 = calculateCourse(curr.latitude, curr.longitude, next.latitude, next.longitude);

                const courseChange = Math.abs(course2 - course1);
                courseChanges.push({index: i, change: courseChange});
            }

            // Sort by course change (highest first) and take top waypoints
            courseChanges.sort((a, b) => b.change - a.change);
            const selectedIndices = courseChanges.slice(0, maxCount).map((item) => item.index);

            // Sort indices to maintain order
            selectedIndices.sort((a, b) => a - b);

            return selectedIndices.map((i) => allWaypoints[i]);
        };

        /**
         * Select waypoints based on distance from start (evenly spaced)
         * @param {string[]} allWaypoints Array of waypoint strings
         * @param {number} maxCount Maximum number of waypoints to select
         * @return {string[]} Selected waypoints
         */
        const selectDistanceBasedWaypoints = (allWaypoints: string[], maxCount: number): string[] => {
            if (allWaypoints.length <= maxCount) return allWaypoints;

            const waypointBreadcrumbs = breadcrumbs.slice(1, -1);

            // Calculate total distance
            let totalDistance = 0;
            for (let i = 1; i < waypointBreadcrumbs.length; i++) {
                totalDistance += calculateDistanceMeters(
                    waypointBreadcrumbs[i-1].latitude, waypointBreadcrumbs[i-1].longitude,
                    waypointBreadcrumbs[i].latitude, waypointBreadcrumbs[i].longitude
                );
            }

            const targetDistance = totalDistance / (maxCount - 1);
            const selected = [];
            let currentDistance = 0;

            selected.push(allWaypoints[0]); // Always include first waypoint

            for (let i = 1; i < waypointBreadcrumbs.length; i++) {
                currentDistance += calculateDistanceMeters(
                    waypointBreadcrumbs[i-1].latitude, waypointBreadcrumbs[i-1].longitude,
                    waypointBreadcrumbs[i].latitude, waypointBreadcrumbs[i].longitude
                );

                if (currentDistance >= targetDistance * (selected.length) && selected.length < maxCount - 1) {
                    selected.push(allWaypoints[i]);
                }
            }

            // Always include last waypoint if not already included
            if (selected.length < maxCount && !selected.includes(allWaypoints[allWaypoints.length - 1])) {
                selected.push(allWaypoints[allWaypoints.length - 1]);
            }

            return selected;
        };

        // Select waypoints based on chosen strategy
        let selectedWaypoints: string[];
        switch (waypointSelectionStrategy) {
        case 'curvature_based':
            selectedWaypoints = selectCurvatureBasedWaypoints(allWaypoints, maxWaypointsPerRequest);
            logger.info(`${userId}: Using curvature-based waypoint selection for track ${trackId}`);
            break;
        case 'distance_based':
            selectedWaypoints = selectDistanceBasedWaypoints(allWaypoints, maxWaypointsPerRequest);
            logger.info(`${userId}: Using distance-based waypoint selection for track ${trackId}`);
            break;
        case 'evenly_distributed':
        default:
            selectedWaypoints = selectEvenlyDistributedWaypoints(allWaypoints, maxWaypointsPerRequest);
            logger.info(`${userId}: Using evenly distributed waypoint selection for track ${trackId}`);
            break;
        }

        logger.info(`${userId}: Selected ${selectedWaypoints.length} waypoints from ${allWaypoints.length} total waypoints for track ${trackId}`);

        // Build the Routes API request body
        const origin = {
            location: {
                latLng: {
                    latitude: startPoint.latitude,
                    longitude: startPoint.longitude,
                },
            },
        };

        const destination = {
            location: {
                latLng: {
                    latitude: endPoint.latitude,
                    longitude: endPoint.longitude,
                },
            },
        };

        // Convert waypoints to Routes API format
        const waypoints = selectedWaypoints.map((waypoint) => {
            const [lat, lng] = waypoint.split(',').map(Number);
            return {
                location: {
                    latLng: {
                        latitude: lat,
                        longitude: lng,
                    },
                },
            };
        });

        const requestBody = {
            origin: origin,
            destination: destination,
            ...(waypoints.length > 0 && {waypoints: waypoints}),
            travelMode: 'DRIVE',
            routingPreference: 'TRAFFIC_AWARE',
            computeAlternativeRoutes: false,
            routeModifiers: {
                avoidTolls: false,
                avoidHighways: false,
            },
            languageCode: 'en-US',
            units: 'METRIC',
        };

        const url = `https://routes.googleapis.com/directions/v2:computeRoutes?key=${googleApiKey}`;

        logger.info(`${userId}: Calling Google Routes API for track ${trackId}`);

        // Call Google Routes API
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Goog-Api-Key': googleApiKey,
                'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline,routes.legs.steps,routes.legs.staticDuration,routes.legs.distanceMeters',
            },
            body: JSON.stringify(requestBody),
        });

        if (!response.ok) {
            const errorText = await response.text();
            logger.error(`${userId}: Google Routes API error for track ${trackId}: ${response.status} - ${errorText}`);

            // Mark as failed but don't throw to avoid retries
            await trackRef.update({
                routesProcessingFailed: true,
                routesProcessingError: `API error: ${response.status}`,
                routesProcessedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
            return;
        }

        const routesResult = await response.json();

        // Validate response structure
        if (!routesResult.routes || routesResult.routes.length === 0) {
            logger.error(`${userId}: Invalid Google Routes API response for track ${trackId}: No routes found`);

            await trackRef.update({
                routesProcessingFailed: true,
                routesProcessingError: `Invalid API response: No routes found`,
                routesProcessedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
            return;
        }

        // Get the first (best) route
        const route = routesResult.routes[0];
        const legs = route.legs;

        if (!legs || legs.length === 0) {
            logger.error(`${userId}: No route legs found for track ${trackId}`);
            return;
        }

        logger.info(`${userId}: Successfully got route with ${legs.length} legs for track ${trackId}`);

        // Extract all steps from all legs to create the route path
        const allSteps: any[] = [];
        legs.forEach((leg: any) => {
            if (leg.steps && Array.isArray(leg.steps)) {
                allSteps.push(...leg.steps);
            }
        });

        // Create enhanced breadcrumbs from the route
        const enhancedBreadcrumbs: any[] = [];
        let currentIndex = 0;

        // Add start point
        enhancedBreadcrumbs.push({
            latitude: startPoint.latitude,
            longitude: startPoint.longitude,
            timestamp: startPoint.timestamp,
            altitude: startPoint.altitude || null,
            speed: startPoint.speed !== null && startPoint.speed !== undefined ? startPoint.speed : 0.0,
            course: startPoint.course || null,
            index: currentIndex++,
            originalBreadcrumbIndex: 0,
        });

        // Process each step to extract intermediate points
        for (let i = 0; i < allSteps.length; i++) {
            const step = allSteps[i];

            // Decode the polyline to get intermediate points
            if (step.polyline && step.polyline.encodedPolyline) {
                const decodedPoints = decodePolyline(step.polyline.encodedPolyline);

                // Add intermediate points (skip first point as it's the same as previous step's end)
                for (let j = 1; j < decodedPoints.length; j++) {
                    const point = decodedPoints[j];

                    // Find the closest original breadcrumb to infer timing
                    const closestOriginal = findClosestOriginalBreadcrumb(
                        point.lat,
                        point.lng,
                        breadcrumbs
                    );

                    // Interpolate timestamp based on progress through the route
                    const progress = (i * decodedPoints.length + j) / (allSteps.length * decodedPoints.length);
                    const startTime = startPoint.timestamp.toMillis();
                    const endTime = endPoint.timestamp.toMillis();
                    const interpolatedTime = startTime + (endTime - startTime) * progress;

                    // Calculate speed and course
                    const inferredSpeed = closestOriginal?.speed !== null && closestOriginal?.speed !== undefined ?
                        closestOriginal.speed :
                        0.0;
                    let inferredCourse = null;

                    if (j > 0) {
                        const prevPoint = decodedPoints[j - 1];
                        inferredCourse = calculateCourse(
                            prevPoint.lat,
                            prevPoint.lng,
                            point.lat,
                            point.lng
                        );
                    }

                    enhancedBreadcrumbs.push({
                        latitude: point.lat,
                        longitude: point.lng,
                        timestamp: admin.firestore.Timestamp.fromMillis(interpolatedTime),
                        // accuracy: null, // Route-based accuracy
                        altitude: closestOriginal?.altitude || null,
                        speed: inferredSpeed,
                        course: inferredCourse,
                        // speedLimit: null, // Google Routes API doesn't provide speed limits
                        // wasProcessedWithRoutes: true,
                        index: currentIndex++,
                        originalBreadcrumbIndex: closestOriginal ? breadcrumbs.indexOf(closestOriginal) : null,
                        // stepDistance: step.distanceMeters || null, // Distance in meters
                        // stepDuration: step.staticDuration || null, // Duration in seconds
                    });

                    // Log first few points for debugging
                    if (currentIndex <= 3) {
                        logger.info(`${userId}: Enhanced breadcrumb ${currentIndex-1}: lat=${(point.lat || 0).toFixed(6)}, lng=${(point.lng || 0).toFixed(6)}`);
                    }
                }
            }
        }

        // Add end point if not already included
        if (enhancedBreadcrumbs.length === 0 ||
            enhancedBreadcrumbs[enhancedBreadcrumbs.length - 1].latitude !== endPoint.latitude ||
            enhancedBreadcrumbs[enhancedBreadcrumbs.length - 1].longitude !== endPoint.longitude) {
            enhancedBreadcrumbs.push({
                latitude: endPoint.latitude,
                longitude: endPoint.longitude,
                timestamp: endPoint.timestamp,
                altitude: endPoint.altitude || null,
                speed: endPoint.speed !== null && endPoint.speed !== undefined ? endPoint.speed : 0.0,
                course: endPoint.course || null,
                wasProcessedWithRoutes: true,
                index: currentIndex++,
                originalBreadcrumbIndex: breadcrumbs.length - 1,
            });
        }

        // Calculate total distance and duration from the route
        const totalDistanceMeters = legs.reduce((sum: number, leg: any) =>
            sum + (leg.distanceMeters || 0), 0,
        );
        const totalDurationSeconds = legs.reduce((sum: number, leg: any) =>
            sum + (leg.staticDuration || 0), 0,
        );

        // Calculate average speed from route data
        const avgSpeedMps = totalDurationSeconds > 0 ? totalDistanceMeters / totalDurationSeconds : 0;
        const avgSpeedKph = avgSpeedMps * 3.6; // Convert m/s to km/h

        // Update the existing track with enhanced data
        const updateData = {
            enhancedBreadcrumbs: enhancedBreadcrumbs,
            processedWithRoutes: true,
            routesProcessingFailed: false,
            routesProcessedAt: admin.firestore.FieldValue.serverTimestamp(),
            waypointSelectionStrategy: waypointSelectionStrategy, // Store which approach was used
            routeSummary: {
                totalDistance: totalDistanceMeters,
                totalDuration: totalDurationSeconds,
                averageSpeed: avgSpeedKph,
                waypointCount: selectedWaypoints.length,
                legCount: legs.length,
                routePolyline: route.polyline?.encodedPolyline || null,
            },
            // Update distance and duration with route data if available
            ...(totalDistanceMeters > 0 && {distance: totalDistanceMeters}),
            ...(totalDurationSeconds > 0 && {duration: totalDurationSeconds}),
            // Update average speed if calculated
            ...(avgSpeedKph > 0 && {avgSpeed: avgSpeedKph}),
        };

        await trackRef.update(updateData);

        logger.info(`${userId}: Successfully updated track ${trackId} with ${enhancedBreadcrumbs.length} enhanced breadcrumbs`);
        logger.info(`${userId}: Route distance: ${totalDistanceMeters.toFixed(2)} meters, duration: ${totalDurationSeconds.toFixed(2)} seconds`);
    } catch (error) {
        logger.error(`${userId}: Error processing track ${trackId} with Google Routes API: ${error}`);

        // Mark as failed but don't throw to avoid infinite retries
        try {
            await trackRef.update({
                routesProcessingFailed: true,
                routesProcessingError: error instanceof Error ? error.message : 'Unknown error',
                routesProcessedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
        } catch (updateError) {
            logger.error(`${userId}: Failed to update error status for track ${trackId}: ${updateError}`);
        }
    }
}

/**
 * Decodes a Google polyline string into an array of lat/lng coordinates
 * @param {string} encoded The encoded polyline string
 * @return {Array} Array of {lat, lng} objects
 */
function decodePolyline(encoded: string): Array<{ lat: number, lng: number }> {
    const points: Array<{ lat: number, lng: number }> = [];
    let index = 0;
    let lat = 0;
    let lng = 0;

    while (index < encoded.length) {
        let b: number;
        let shift = 0;
        let result = 0;
        do {
            b = encoded.charCodeAt(index++) - 63;
            result |= (b & 0x1f) << shift;
            shift += 5;
        } while (b >= 0x20);
        const dlat = ((result & 1) ? ~(result >> 1) : (result >> 1));
        lat += dlat;

        shift = 0;
        result = 0;
        do {
            b = encoded.charCodeAt(index++) - 63;
            result |= (b & 0x1f) << shift;
            shift += 5;
        } while (b >= 0x20);
        const dlng = ((result & 1) ? ~(result >> 1) : (result >> 1));
        lng += dlng;

        points.push({lat: lat / 1e5, lng: lng / 1e5});
    }
    return points;
}

/**
 * Cloud Function triggered when a track is created
 * Creates a track notification AND automatically processes the track through Google Roads API
 */
export const onTrackCreated = onDocumentCreated({
    document: 'users/{userId}/tracks/{trackId}',
    secrets: [googleApiKeySecret],
}, async (event) => {
    const userId = event.params.userId;
    const trackId = event.params.trackId;
    const trackData = event.data?.data();

    if (!trackData) {
        logger.error(`${userId}: No track data found for track ${trackId}`);
        return;
    }

    // Check if this track was created from a live track deletion
    // if (trackData.fromLiveTrack === true) {
    //     logger.info(`${userId}: Track ${trackId} was created from live track deletion, skipping enhancement processing`);

    //     // Only create notification for live track conversions
    //     await createTrackNotification(userId, trackId, trackData);
    //     return;
    // }

    logger.info(`${userId}: Processing new track ${trackId} - creating notification and processing with Google Roads API`);

    // Configuration: Choose which processing method to use: 'routes' | 'directions' | 'roads'
    // eslint-disable-next-line prefer-const
    let trackProcessingMethod: 'routes' | 'directions' | 'roads' = 'routes';

    // Execute operations in parallel for better performance
    const processingOperations = [
        createTrackNotification(userId, trackId, trackData),
    ];

    // Add the chosen processing method
    if (trackProcessingMethod === 'routes') {
        processingOperations.push(processTrackWithGoogleRoutes(userId, trackId, trackData, event.data!.ref));
        logger.info(`${userId}: Using Google Routes API for track ${trackId}`);
    } else if (trackProcessingMethod === 'directions') {
        processingOperations.push(processTrackWithGoogleDirections(userId, trackId, trackData, event.data!.ref));
        logger.info(`${userId}: Using Google Directions API for track ${trackId}`);
    } else {
        processingOperations.push(processTrackWithGoogleRoads(userId, trackId, trackData, event.data!.ref));
        logger.info(`${userId}: Using Google Roads API for track ${trackId}`);
    }

    await Promise.allSettled(processingOperations);

    logger.info(`${userId}: Completed processing for track ${trackId}`);
});

export const onLiveTrackDeleted = onDocumentDeleted('users/{userId}/liveTracks/{trackId}', async (event) => {
    const userId = event.params.userId;
    const trackId = event.params.trackId;
    const deletedData = event.data?.data();

    console.log(`[User: ${userId}] LiveTrack document with ID ${trackId} was deleted`);
    console.log(`[User: ${userId}] Deleted data:`, deletedData);

    try {
        // Get all locations before deletion
        const locationsRef = db.collection(`users/${userId}/liveTracks/${trackId}/locations`);
        const locationsSnapshot = await locationsRef.get();
        console.log(`[User: ${userId}] Found ${locationsSnapshot.size} location documents for track ${trackId}`);

        if (!locationsSnapshot.empty) {
            let totalSpeed = 0;
            let maxSpeed = 0;
            let startTime: Timestamp | null = null;
            let endTime: Timestamp | null = null;
            let locationCount = 0;
            const breadcrumbs: any[] = [];

            // Process all locations in order
            await Promise.all(locationsSnapshot.docs.map(async (doc, index) => {
                const locationData = doc.data();
                const speed = locationData.speed || 0;
                const timestamp = locationData.timestamp as Timestamp;

                if (!(timestamp instanceof Timestamp)) {
                    console.error(`[User: ${userId}] Invalid timestamp format in location document`);
                    return;
                }

                // Update metrics - ensure speed is a valid number
                const validSpeed = (typeof speed === 'number' && !isNaN(speed)) ? speed : 0;
                totalSpeed += validSpeed;
                maxSpeed = Math.max(maxSpeed, validSpeed);
                locationCount++;

                // Update start and end times
                const timestampMillis = timestamp.toMillis();
                if (!startTime || timestampMillis < startTime.toMillis()) {
                    startTime = timestamp;
                }
                if (!endTime || timestampMillis > endTime.toMillis()) {
                    endTime = timestamp;
                }

                // Add location data to breadcrumbs array with index
                breadcrumbs.push({
                    ...locationData,
                    index: index,
                    originalBreadcrumbIndex: index,
                    wasProcessedWithDirections: false,
                });
            }));

            // Calculate final metrics - ensure avgSpeed is always a valid number
            let avgSpeed = locationCount > 0 ? totalSpeed / locationCount : 0;
            avgSpeed = (typeof avgSpeed === 'number' && !isNaN(avgSpeed)) ? avgSpeed : 0;
            const duration = startTime && endTime ?
                Math.floor(((endTime as Timestamp).toMillis() - (startTime as Timestamp).toMillis()) / 1000) : 0; // Duration in seconds as integer

            // Validate track data before creating new track
            if (locationCount < 5 || deletedData?.distance === 0 || avgSpeed === 0) {
                console.log(`[User: ${userId}] Track validation failed - Not creating new track. Metrics:`, {
                    locationCount,
                    totalDistance: deletedData?.distance,
                    avgSpeed: avgSpeed,
                });
            } else {
                // Create new track document using the LiveTrack's ID
                const newTrackRef = db.collection(`users/${userId}/tracks`).doc(trackId);

                // Create track document with summary data
                await newTrackRef.set({
                    id: trackId,
                    startTime,
                    endTime,
                    avgSpeed: avgSpeed,
                    maxSpeed: maxSpeed,
                    distance: deletedData?.distance,
                    duration: duration,
                    locationCount,
                    dateCreated: Timestamp.now(),
                    breadcrumbs,
                    name: deletedData?.name,
                    startAddress: deletedData?.startAddress,
                    endAddress: deletedData?.endAddress,
                    screenAccessCount: deletedData?.screenAccessCount,
                });

                // Get user's circles and notify circle members
                const userDoc = await db.collection('users').where('userId', '==', userId).get();
                if (!userDoc.empty) {
                    const userData = userDoc.docs[0].data();
                    const circleIds = userData.circleIds || [];
                    const userName = userData.name || 'Someone';

                    // Process each circle the user is a member of
                    const circlePromises = circleIds.map(async (circleId: string) => {
                        try {
                            const circleDoc = await db.collection('circles').doc(circleId).get();
                            if (circleDoc.exists) {
                                const circleData = circleDoc.data();
                                const circleUsers = circleData?.users || [];

                                // Notify each user in the circle (except the track creator)
                                const notificationPromises = circleUsers
                                    // .filter((user: any) => user.id !== userId) // Don't notify the track creator
                                    .map(async (user: any) => {
                                        try {
                                            // Get device token for circle member
                                            const deviceToken = await getDeviceToken(user.id);

                                            if (deviceToken) {
                                                const title = 'New Track';
                                                const body = `${userName} completed a track: ${deletedData?.name || 'Untitled Track'}`;

                                                // Send push notification
                                                await sendPushNotification(deviceToken, title, body);
                                                console.log(`[User: ${userId}] Sent track notification to circle member ${user.id}`);
                                            }
                                        } catch (error) {
                                            console.error(`[User: ${userId}] Error sending notification to circle member ${user.id}:`, error);
                                        }
                                    });

                                await Promise.all(notificationPromises);
                            }
                        } catch (error) {
                            console.error(`[User: ${userId}] Error processing circle ${circleId}:`, error);
                        }
                    });

                    await Promise.all(circlePromises);
                }

                // Log the calculated metrics
                console.log(`[User: ${userId}] Track Metrics for ${newTrackRef.id}:`, {
                    averageSpeed: avgSpeed.toFixed(2),
                    maxSpeed: maxSpeed.toFixed(2),
                    duration: duration.toFixed(2),
                    totalDistance: (deletedData?.distance || 0).toFixed(2),
                    locationCount,
                });
            }
        } else {
            console.log(`[User: ${userId}] No location documents found for track ${trackId}, skipping track creation`);
        }

        // Now delete the locations collection
        await deleteSubCollection(locationsRef);
        console.log(`[User: ${userId}] All documents in 'locations' sub-collection under LiveTrack ${trackId} deleted.`);
    } catch (error) {
        console.error(`[User: ${userId}] Error during LiveTrack deletion operation for trackId: ${trackId}`, error);
    }

    return Promise.resolve();
});

export const onLiveTrackCreated = onDocumentCreated('users/{userId}/liveTracks/{trackId}', async (event) => {
    const userId = event.params.userId;
    const trackId = event.params.trackId;
    const createdData = event.data?.data();

    console.log(`[User: ${userId}] LiveTrack document with ID ${trackId} was created`);
    console.log(`[User: ${userId}] Created data:`, createdData);

    try {
        // Delete all documents in the Locations subcollection
        const locationsRef = db.collection(`users/${userId}/liveTracks/${trackId}/locations`);
        await deleteSubCollection(locationsRef);
        // You can add any initialization logic here for new LiveTrack documents
        console.log(`[User: ${userId}] Successfully processed new LiveTrack creation for trackId: ${trackId}`);
    } catch (error) {
        console.error(`[User: ${userId}] Error during LiveTrack creation operation for trackId: ${trackId}`, error);
    }

    return Promise.resolve();
});

/**
 * Scheduled function that runs every 10 minutes to expire old LiveTracks
 * Automatically deletes LiveTracks that haven't been updated for more than 30 minutes
 */
export const expireOldLiveTracks = onSchedule({
    schedule: 'every 10 minutes',
    timeZone: 'UTC',
}, async () => {
    console.log('LiveTrack expiration check function triggered at:', new Date().toISOString());

    try {
        // Get all users
        const usersSnapshot = await db.collection('users').get();

        if (usersSnapshot.empty) {
            console.log('No users found, skipping LiveTrack expiration check');
            return;
        }

        let expiredCount = 0;
        const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);
        const thirtyMinutesAgoTimestamp = Timestamp.fromDate(thirtyMinutesAgo);

        // Process each user's LiveTracks
        for (const userDoc of usersSnapshot.docs) {
            const userData = userDoc.data();
            const userId = userData.userId;

            if (!userId) continue;

            // Get user's LiveTracks
            const liveTracksSnapshot = await db.collection(`users/${userId}/liveTracks`).get();

            for (const liveTrackDoc of liveTracksSnapshot.docs) {
                const liveTrackData = liveTrackDoc.data();
                const lastUpdate = liveTrackData.lastUpdate || liveTrackData.dateCreated;

                // Check if LiveTrack is older than 30 minutes
                if (lastUpdate && lastUpdate.toMillis() < thirtyMinutesAgoTimestamp.toMillis()) {
                    try {
                        console.log(`[User: ${userId}] Expiring LiveTrack ${liveTrackDoc.id} (last update: ${lastUpdate.toDate().toISOString()})`);

                        // Delete the LiveTrack document (this will trigger onLiveTrackDeleted)
                        await liveTrackDoc.ref.delete();
                        expiredCount++;
                    } catch (error) {
                        console.error(`[User: ${userId}] Error expiring LiveTrack ${liveTrackDoc.id}:`, error);
                    }
                }
            }
        }

        console.log(`Expired ${expiredCount} old LiveTracks`);
    } catch (error) {
        console.error('Error in LiveTrack expiration function:', error);
    }
});

export const scheduledFunction = onSchedule({
    schedule: 'every 15 minutes',
    timeZone: 'UTC',
}, async () => {
    console.log('Scheduled function triggered at:', new Date().toISOString());

    try {
        // Get all users from the users collection
        const usersSnapshot = await db.collection('users').get();

        if (usersSnapshot.empty) {
            console.log('No users found in the database');
            return;
        }

        console.log(`Found ${usersSnapshot.size} users to process`);

        // Process each user and send a silent notification
        const notificationPromises = usersSnapshot.docs.map(async (userDoc) => {
            const userData = userDoc.data();
            const userId = userData.userId;

            if (!userId) {
                console.log(`User document ${userDoc.id} has no userId field, skipping`);
                return;
            }

            // Get the device token for this user
            const deviceToken = await getDeviceToken(userId);

            if (!deviceToken) {
                console.log(`No device token found for user ${userId}, skipping notification`);
                return;
            }

            // Create notification content
            const content = JSON.stringify({
                action: 'refresh',
                timestamp: new Date().toISOString(),
            });

            // Send the silent notification
            const result = await sendSilentPushNotification(deviceToken, content);

            if (result) {
                console.log(`Successfully sent silent notification to user ${userId}`);
            } else {
                console.log(`Failed to send silent notification to user ${userId}`);
            }
        });

        // Wait for all notifications to be sent
        await Promise.all(notificationPromises);

        console.log('Scheduled function completed successfully');
    } catch (error) {
        console.error('Error in scheduled function:', error);
        throw error;
    }
});

/**
 * Scheduled function that runs every 20 minutes to check user activity
 * Updates users to "stationary" status if they haven't been active for more than 20 minutes
 */
export const checkUserActivity = onSchedule({
    schedule: 'every 20 minutes',
    timeZone: 'UTC',
}, async () => {
    console.log('User activity check function triggered at:', new Date().toISOString());

    try {
        // Get all users from the users collection
        const usersSnapshot = await db.collection('users').get();

        if (usersSnapshot.empty) {
            console.log('No users found in the database');
            return;
        }

        console.log(`Found ${usersSnapshot.size} users to check for activity`);

        // Calculate the threshold time (20 minutes ago)
        const twentyMinutesAgo = new Date(Date.now() - 20 * 60 * 1000);
        const twentyMinutesAgoTimestamp = Timestamp.fromDate(twentyMinutesAgo);

        let updatedCount = 0;
        let skippedCount = 0;

        // Process each user to check their activity
        const updatePromises = usersSnapshot.docs.map(async (userDoc) => {
            const userData = userDoc.data();
            const userId = userData.userId;
            const lastActivity = userData.lastActivity;
            const currentActivity = userData.activity;

            if (!userId) {
                console.log(`User document ${userDoc.id} has no userId field, skipping`);
                skippedCount++;
                return;
            }

            // Check if lastActivity field exists and is a valid Timestamp
            if (!lastActivity || !(lastActivity instanceof Timestamp)) {
                console.log(`User ${userId} has no valid lastActivity timestamp, skipping`);
                skippedCount++;
                return;
            }

            // Check if user has been inactive for more than 20 minutes
            if (lastActivity.toMillis() < twentyMinutesAgoTimestamp.toMillis()) {
                // Only update if the current activity is not already "stationary"
                if (currentActivity !== 'stationary') {
                    try {
                        await userDoc.ref.update({
                            activity: 'stationary',
                            lastActivity: Timestamp.now(),
                        });

                        console.log(`Updated user ${userId} to stationary status (last activity: ${lastActivity.toDate().toISOString()})`);
                        updatedCount++;
                    } catch (error) {
                        console.error(`Error updating user ${userId} activity status:`, error);
                    }
                } else {
                    console.log(`User ${userId} is already stationary, skipping update`);
                    skippedCount++;
                }
            } else {
                console.log(`User ${userId} is still active (last activity: ${lastActivity.toDate().toISOString()})`);
                skippedCount++;
            }
        });

        // Wait for all updates to complete
        await Promise.all(updatePromises);

        console.log(`User activity check completed: ${updatedCount} users updated to stationary, ${skippedCount} users skipped`);
    } catch (error) {
        console.error('Error in user activity check function:', error);
        throw error;
    }
});
